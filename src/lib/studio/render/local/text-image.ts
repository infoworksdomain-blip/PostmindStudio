import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import {
  FONT_STACKS,
  fontsDir,
  loadMetrics,
  measurerFor,
  type FontFace,
  type FontStack,
} from '../../carousel/fonts';
import { TextSetter, startsRightToLeft, type TextImage } from '../../carousel/render';
import { cleanSlideText, wrapLine } from '../../carousel/text';
import type { Script } from '../../i18n/scripts';
import { cssOf, hexOf } from './edit-json';
import type { BoxPosition, TextCard } from './text-card';

// BACKLOG 23.5 — a text card (text-card.ts) drawn as a transparent PNG with the carousel text
// pipeline (21.6): bundled fonts (public/fonts), widths from the fonts' own metrics
// (carousel/font-metrics.ts) for line breaking, and one libvips/Pango line image per line
// (carousel/render.ts TextSetter, whose invisible strut gives every line the same box).
// Deterministic: same card → same bytes. The TikTok-classic outline (white, black 3 px stroke) is
// the line drawn in the stroke colour at 16 offsets around a circle of the stroke width under the
// fill; a soft shadow is the line in the shadow colour, blurred and offset. sharp operations used
// (composite, extend, blur, extract, create): https://sharp.pixelplumbing.com/api-composite,
// https://sharp.pixelplumbing.com/api-resize, https://sharp.pixelplumbing.com/api-operation
// (read 2026-10-06).

export interface RenderedImage {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
}

const STROKE_DIRECTIONS = 16;
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/** The writing system of a run of text (picks the measurement and the fallback order). */
export function scriptOfText(text: string): Script {
  if (/\p{Script=Arabic}/u.test(text)) return 'arabic';
  if (/\p{Script=Devanagari}/u.test(text)) return 'devanagari';
  if (/\p{Script=Han}/u.test(text)) return 'han';
  return 'latin';
}

/** The bundled file for a family (<FamilyNoSpaces>.ttf, the fonts-host naming), if any. */
export function bundledFace(family: string, dir = fontsDir()): FontFace | null {
  const file = `${family.replace(/ /g, '')}.ttf`;
  return existsSync(path.join(dir, file)) ? { family, file } : null;
}

const setters = new Map<string, { stack: FontStack; setter: TextSetter }>();

/**
 * A font stack for `family`: the bundled face first, then the script's stack and every other
 * bundled Noto face (Pango falls back through the list per glyph). A family that is not bundled
 * (e.g. 'Arial') is drawn in the script's default face.
 */
export function stackFor(
  family: string,
  script: Script,
  dir = fontsDir(),
): { stack: FontStack; setter: TextSetter; substituted: boolean } {
  const own = bundledFace(family, dir);
  const key = `${dir}|${own?.file ?? '-'}|${script}`;
  const cached = setters.get(key);
  const substituted = own === null;
  if (cached) return { ...cached, substituted };
  const faces: FontFace[] = [];
  for (const face of [own, ...FONT_STACKS[script], ...Object.values(FONT_STACKS).flat()]) {
    if (face && !faces.some((f) => f.file === face.file)) faces.push(face);
  }
  const { measure, covered } = measurerFor(
    faces.map((f) => loadMetrics(f, dir)),
    script,
  );
  const stack: FontStack = { script, faces, measure, covered };
  const entry = { stack, setter: new TextSetter(stack, dir) };
  setters.set(key, entry);
  return { ...entry, substituted };
}

interface Line {
  readonly text: string;
  readonly sizePx: number;
  readonly bold: boolean;
  readonly colour: string;
  /** Top of the line box within the block's content area. */
  readonly y: number;
  readonly advance: number;
}

/** Break the card's paragraphs into lines that fit `maxWidth` (font metrics widths). */
export function layoutLines(
  card: TextCard,
  stack: Pick<FontStack, 'measure' | 'covered'>,
  maxWidth: number,
): { lines: Line[]; height: number; removed: number } {
  const lines: Line[] = [];
  let y = 0;
  let removed = 0;
  card.paragraphs.forEach((para, index) => {
    const raw = card.collapseWhitespace ? para.text.replace(/\s+/g, ' ').trim() : para.text;
    const clean = cleanSlideText(raw, stack.covered);
    removed += clean.removed;
    if (!clean.text) return;
    if (index > 0) y += para.marginTopPx;
    const advance = Math.round(para.sizePx * card.lineHeight);
    const width = (s: string) => stack.measure(s, para.sizePx, para.bold);
    for (const logical of clean.text.split('\n')) {
      const wrapped = logical.trim() ? wrapLine(logical, maxWidth, width) : [''];
      for (const text of wrapped) {
        lines.push({
          text,
          sizePx: para.sizePx,
          bold: para.bold,
          colour: hexOf(para.colour),
          y,
          advance,
        });
        y += advance;
      }
    }
  });
  return { lines, height: y, removed };
}

/** Top-left of a w×h item placed at `position` inside a W×H area. */
export function placeIn(
  position: BoxPosition,
  item: { width: number; height: number },
  area: { width: number; height: number },
): { x: number; y: number } {
  const freeX = area.width - item.width;
  const freeY = area.height - item.height;
  const x = /Left$|^left$/.test(position) ? 0 : /Right$|^right$/.test(position) ? freeX : freeX / 2;
  const y = /^top/.test(position) ? 0 : /^bottom/.test(position) ? freeY : freeY / 2;
  return { x: Math.round(x), y: Math.round(y) };
}

interface SetLine {
  readonly line: Line;
  readonly image: TextImage;
  readonly ink: number;
  /** Left edge of the ink inside the line image (the strut is left of RTL text). */
  readonly inkLeft: number;
}

async function setLines(setter: TextSetter, lines: Line[]): Promise<SetLine[]> {
  const out: SetLine[] = [];
  for (const line of lines) {
    if (!line.text) continue;
    const image = await setter.set(line.text, line.sizePx, line.bold, line.colour);
    const ink = Math.max(0, image.width - (await setter.strutWidth(line.sizePx, line.bold)));
    const inkLeft = startsRightToLeft(line.text) ? image.width - ink : 0;
    out.push({ line, image, ink, inkLeft });
  }
  return out;
}

function strokeOffsets(width: number): Array<{ dx: number; dy: number }> {
  const offsets: Array<{ dx: number; dy: number }> = [];
  const rings = width > 2 ? [width, width / 2] : [width];
  for (const r of rings) {
    for (let k = 0; k < STROKE_DIRECTIONS; k += 1) {
      const a = (2 * Math.PI * k) / STROKE_DIRECTIONS;
      offsets.push({ dx: Math.round(Math.cos(a) * r), dy: Math.round(Math.sin(a) * r) });
    }
  }
  return offsets.filter((o, i) => offsets.findIndex((p) => p.dx === o.dx && p.dy === o.dy) === i);
}

function roundedRectSvg(width: number, height: number, radius: number, fill: string): Buffer {
  const r = Math.min(radius, width / 2, height / 2);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="0" y="0" width="${width}" height="${height}" rx="${r}" ry="${r}" fill="${fill}"/></svg>`,
  );
}

interface Piece {
  readonly input: Buffer;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The text block (background, shadow, stroke, fill). Pieces may reach past the block (stroke,
 * shadow, a line's strut), so the canvas is the union of every piece; `originX/Y` is where the
 * block's own top-left corner lands in it.
 */
async function drawBlock(
  card: TextCard,
  setter: TextSetter,
  set: SetLine[],
  geometry: { width: number; height: number; pad: number },
): Promise<{ png: Buffer; originX: number; originY: number; width: number; height: number }> {
  const pieces: Piece[] = [];
  if (card.blockBackground) {
    pieces.push({
      input: roundedRectSvg(
        geometry.width,
        geometry.height,
        card.blockBackground.radiusPx,
        cssOf(card.blockBackground.colour),
      ),
      left: 0,
      top: 0,
      width: geometry.width,
      height: geometry.height,
    });
  }
  const lineLeft = (s: SetLine) => {
    const free = geometry.width - geometry.pad * 2 - s.ink;
    const inkX = card.align === 'left' ? 0 : card.align === 'right' ? free : free / 2;
    return Math.round(geometry.pad + inkX - s.inkLeft);
  };
  const lineTop = (s: SetLine) =>
    Math.round(geometry.pad + s.line.y + (s.line.advance - s.image.height) / 2);
  const shadow = card.shadow;
  if (shadow) {
    const blur = Math.max(0, Math.round(shadow.blurPx));
    for (const s of set) {
      const shade = await setter.set(s.line.text, s.line.sizePx, s.line.bold, hexOf(shadow.colour));
      const grown = await sharp(shade.buffer)
        .extend({ top: blur, bottom: blur, left: blur, right: blur, background: TRANSPARENT })
        .png()
        .toBuffer();
      const input =
        blur > 0
          ? await sharp(grown)
              .blur(Math.max(0.3, blur / 2))
              .png()
              .toBuffer()
          : grown;
      pieces.push({
        input,
        left: lineLeft(s) - blur + Math.round(shadow.offsetX),
        top: lineTop(s) - blur + Math.round(shadow.offsetY),
        width: shade.width + blur * 2,
        height: shade.height + blur * 2,
      });
    }
  }
  if (card.stroke) {
    const offsets = strokeOffsets(card.stroke.widthPx);
    for (const s of set) {
      const outline = await setter.set(
        s.line.text,
        s.line.sizePx,
        s.line.bold,
        hexOf(card.stroke.colour),
      );
      for (const o of offsets) {
        pieces.push({
          input: outline.buffer,
          left: lineLeft(s) + o.dx,
          top: lineTop(s) + o.dy,
          width: outline.width,
          height: outline.height,
        });
      }
    }
  }
  for (const s of set) {
    pieces.push({
      input: s.image.buffer,
      left: lineLeft(s),
      top: lineTop(s),
      width: s.image.width,
      height: s.image.height,
    });
  }
  const minX = Math.min(0, ...pieces.map((p) => p.left));
  const minY = Math.min(0, ...pieces.map((p) => p.top));
  const width = Math.max(geometry.width, ...pieces.map((p) => p.left + p.width)) - minX;
  const height = Math.max(geometry.height, ...pieces.map((p) => p.top + p.height)) - minY;
  const layers: OverlayOptions[] = pieces.map((p) => ({
    input: p.input,
    left: p.left - minX,
    top: p.top - minY,
  }));
  const png = await sharp({ create: { width, height, channels: 4, background: TRANSPARENT } })
    .composite(layers)
    .png()
    .toBuffer();
  return { png, originX: -minX, originY: -minY, width, height };
}
export interface TextRenderResult extends RenderedImage {
  readonly notes: readonly string[];
}

/** Draw a text card as a transparent PNG the size of its box. */
export async function renderTextCard(card: TextCard, dir = fontsDir()): Promise<TextRenderResult> {
  const notes: string[] = [];
  const allText = card.paragraphs.map((p) => p.text).join(' ');
  const { stack, setter, substituted } = stackFor(card.fontFamily, scriptOfText(allText), dir);
  if (substituted && allText.trim())
    notes.push(`font ${card.fontFamily} drawn in ${stack.faces[0]?.family ?? 'Inter'}`);
  const pad = card.blockBackground?.paddingPx ?? 0;
  const {
    lines,
    height: textHeight,
    removed,
  } = layoutLines(card, stack, Math.max(1, card.width - pad * 2));
  if (removed > 0) notes.push('characters no bundled font has were left out');
  const set = await setLines(setter, lines);
  const base = sharp({
    create: {
      width: card.width,
      height: card.height,
      channels: 4,
      background: card.fill
        ? { r: card.fill.r, g: card.fill.g, b: card.fill.b, alpha: card.fill.a }
        : TRANSPARENT,
    },
  });
  if (lines.length === 0) {
    return { png: await base.png().toBuffer(), width: card.width, height: card.height, notes };
  }
  const inkWidth = Math.max(0, ...set.map((s) => s.ink));
  const geometry = {
    width: card.blockBackground?.fullWidth ? card.width : Math.ceil(inkWidth + pad * 2),
    height: Math.ceil(textHeight + pad * 2),
    pad,
  };
  const block = await drawBlock(card, setter, set, geometry);
  // Place the block in the box; whatever falls outside the box is masked (as Shotstack does).
  const at = placeIn(card.anchor, geometry, card);
  const left = at.x - block.originX;
  const top = at.y - block.originY;
  const visible = {
    left: Math.max(0, -left),
    top: Math.max(0, -top),
    right: Math.min(block.width, card.width - left),
    bottom: Math.min(block.height, card.height - top),
  };
  if (visible.right <= visible.left || visible.bottom <= visible.top) {
    return { png: await base.png().toBuffer(), width: card.width, height: card.height, notes };
  }
  if (geometry.height > card.height) notes.push('text taller than its box was masked');
  const piece = await sharp(block.png)
    .extract({
      left: visible.left,
      top: visible.top,
      width: visible.right - visible.left,
      height: visible.bottom - visible.top,
    })
    .png()
    .toBuffer();
  const png = await base
    .composite([{ input: piece, left: Math.max(0, left), top: Math.max(0, top) }])
    .png()
    .toBuffer();
  return { png, width: card.width, height: card.height, notes };
}
