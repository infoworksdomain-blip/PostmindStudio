// Server-side render of carousel slides to PNG (and JPEG for Instagram/TikTok, which take JPEG
// only) with sharp, 21.6. Deterministic: the shape layer is SVG (svg.ts), glyphs are set by
// libvips/Pango from the bundled font files (fonts.ts), pictures are resized with their aspect
// ratio kept. Same inputs → same bytes.
// sharp text input (font, fontfile, rgba, dpi, wrap): https://sharp.pixelplumbing.com/api-constructor
// (read 2026-10-04). Pango markup (span foreground / fgalpha):
// https://docs.gtk.org/Pango/pango_markup.html (read 2026-10-04).
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { THEMES } from './constants';
import { fontsDir, type FontStack } from './fonts';
import {
  buildSlideLayout,
  type LayoutContext,
  type SlideElement,
  type SlideLayout,
} from './layout';
import { checkSlide, type RenderedText, type SlideIssue } from './quality';
import { circleMaskSvg, roundedMaskSvg, slideShapesSvg } from './svg';
import type { SlidePlan } from './types';

/** Fetches a picture's bytes by image library id. */
export type ImageLoader = (imageId: string) => Promise<Buffer>;

export interface RenderInput {
  readonly plans: readonly SlidePlan[];
  readonly context: Omit<LayoutContext, 'measure'>;
  readonly fonts: FontStack;
  readonly loadImage: ImageLoader;
  readonly logo: Buffer | null;
  /** Source dimensions per image id, for the stretch check. */
  readonly imageSizes: ReadonlyMap<string, { width: number; height: number }>;
  readonly fontsDirectory?: string;
}

export interface RenderedSlide {
  readonly index: number;
  readonly png: Buffer;
  readonly jpeg: Buffer;
  readonly layout: SlideLayout;
  readonly issues: readonly SlideIssue[];
}

// An invisible run after each line ("strut") gives every line image the same ink box (accent top,
// descender bottom), so lines sit on one grid although libvips crops text to its ink. Arabic adds
// a tall lam and a hamza below.
const LATIN_STRUT = 'Éj';
const ARABIC_STRUT = 'Éjلإ';

const STRONG_LETTER = /\p{L}/u;
const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u;

/** True when the first letter of `text` is right-to-left (Unicode bidi "first strong"). */
export function startsRightToLeft(text: string): boolean {
  for (const ch of text) {
    if (STRONG_LETTER.test(ch)) return RTL_LETTER.test(ch);
  }
  return false;
}

function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface TextImage {
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
}

/** Sets one line of text per call (also the 23.5 local video renderer's text, render/local). */
export class TextSetter {
  private readonly strutWidths = new Map<string, number>();
  private registered = false;

  constructor(
    private readonly fonts: FontStack,
    private readonly dir: string,
  ) {}

  private get strut(): string {
    return this.fonts.script === 'arabic' ? ARABIC_STRUT : LATIN_STRUT;
  }

  private description(size: number, bold: boolean): string {
    const families = this.fonts.faces.map((f) => f.family).join(', ');
    // opsz pinned so Inter does not switch to its tighter display cut at large sizes: the layout's
    // widths are the default (text) instance's.
    return `${families} ${bold ? 'Bold ' : ''}${size} @opsz=14`;
  }

  /** Make every face of the stack known to fontconfig before the first real line. */
  private async register(): Promise<void> {
    if (this.registered) return;
    for (const face of [...this.fonts.faces].reverse()) {
      await sharp({
        text: { text: 'x', font: `${face.family} 10`, fontfile: path.join(this.dir, face.file) },
      })
        .png()
        .toBuffer();
    }
    this.registered = true;
  }

  async set(text: string, size: number, bold: boolean, colour: string): Promise<TextImage> {
    await this.register();
    const primary = this.fonts.faces[0];
    if (!primary) throw new RangeError('font stack is empty');
    const markup = `<span foreground="${colour}">${escapeMarkup(text)}</span><span fgalpha="1">${this.strut}</span>`;
    const { data, info } = await sharp({
      text: {
        text: markup,
        font: this.description(size, bold),
        fontfile: path.join(this.dir, primary.file),
        rgba: true,
        dpi: 72,
        wrap: 'none',
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  }

  /** Width of the invisible strut at this size (subtracted to get the text's own ink width). */
  async strutWidth(size: number, bold: boolean): Promise<number> {
    const key = `${size}:${bold}`;
    const known = this.strutWidths.get(key);
    if (known !== undefined) return known;
    await this.register();
    const primary = this.fonts.faces[0];
    if (!primary) throw new RangeError('font stack is empty');
    const { info } = await sharp({
      text: {
        text: this.strut,
        font: this.description(size, bold),
        fontfile: path.join(this.dir, primary.file),
        rgba: true,
        dpi: 72,
        wrap: 'none',
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    this.strutWidths.set(key, info.width);
    return info.width;
  }
}

async function roundedPicture(
  source: Buffer,
  width: number,
  height: number,
  radius: number,
): Promise<Buffer> {
  return sharp(source)
    .rotate()
    .resize(width, height, { fit: 'cover', position: 'centre' })
    .ensureAlpha()
    .composite([{ input: Buffer.from(roundedMaskSvg(width, height, radius)), blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function avatarPicture(logo: Buffer, size: number, background: string): Promise<Buffer> {
  return sharp(logo)
    .rotate()
    .resize(size, size, { fit: 'contain', background })
    .flatten({ background })
    .ensureAlpha()
    .composite([{ input: Buffer.from(circleMaskSvg(size)), blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function textOverlay(
  el: Extract<SlideElement, { type: 'text' }>,
  setter: TextSetter,
): Promise<{ overlay: OverlayOptions; inkWidth: number } | null> {
  if (el.text.trim().length === 0) return null;
  const image = await setter.set(el.text, el.fontSize, el.bold, el.colour);
  const inkWidth = Math.max(0, image.width - (await setter.strutWidth(el.fontSize, el.bold)));
  // Pango lays a line out in the direction of its first strong letter, and the strut follows the
  // text in reading order: on the right of a left-to-right line, on the left of an Arabic one.
  const strutOnLeft = startsRightToLeft(el.text);
  const left =
    el.align === 'left'
      ? el.x - (strutOnLeft ? image.width - inkWidth : 0)
      : el.x - (strutOnLeft ? image.width : inkWidth);
  const top = el.y + Math.round((el.lineHeight - image.height) / 2);
  return {
    overlay: { input: image.buffer, left: Math.round(left), top: Math.max(0, top) },
    inkWidth,
  };
}

async function renderOne(
  plan: SlidePlan,
  input: RenderInput,
  setter: TextSetter,
): Promise<RenderedSlide> {
  const colours = THEMES[input.context.theme];
  const layout = buildSlideLayout(plan, { ...input.context, measure: input.fonts.measure });
  const overlays: OverlayOptions[] = [];
  const rendered: RenderedText[] = [];
  const avatar = input.logo ? await avatarPicture(input.logo, 80, colours.avatarFallback) : null;
  for (const [index, el] of layout.elements.entries()) {
    if (el.type === 'image') {
      const source = await input.loadImage(el.imageId);
      overlays.push({
        input: await roundedPicture(source, el.width, el.height, el.radius),
        left: el.x,
        top: el.y,
      });
    } else if (el.type === 'avatar') {
      if (avatar) {
        overlays.push({ input: avatar, left: el.x, top: el.y });
      } else if (el.initial) {
        const initial = await setter.set(
          el.initial,
          Math.round(el.size * 0.45),
          true,
          colours.text,
        );
        const ink = initial.width - (await setter.strutWidth(Math.round(el.size * 0.45), true));
        overlays.push({
          input: initial.buffer,
          left: Math.round(el.x + (el.size - ink) / 2),
          top: Math.round(el.y + (el.size - initial.height) / 2),
        });
      }
    } else if (el.type === 'text') {
      const text = await textOverlay(el, setter);
      if (text) {
        overlays.push(text.overlay);
        rendered.push({ elementIndex: index, width: text.inkWidth });
      }
    }
  }
  const base = sharp(Buffer.from(slideShapesSvg(layout, colours.avatarFallback)));
  const png = await base.composite(overlays).png({ compressionLevel: 9 }).toBuffer();
  const jpeg = await sharp(png)
    .flatten({ background: colours.background })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const issues = checkSlide({ slide: plan.index, layout, rendered, sources: input.imageSizes });
  return { index: plan.index, png, jpeg, layout, issues };
}

/** Render every slide, in order. */
export async function renderSlides(input: RenderInput): Promise<RenderedSlide[]> {
  const setter = new TextSetter(input.fonts, input.fontsDirectory ?? fontsDir());
  const out: RenderedSlide[] = [];
  for (const plan of input.plans) {
    out.push(await renderOne(plan, input, setter));
  }
  return out;
}

/** A smaller JPEG of a rendered slide for the editor's live preview. */
export async function previewJpeg(png: Buffer, width = 540): Promise<Buffer> {
  return sharp(png).resize({ width }).jpeg({ quality: 80 }).toBuffer();
}
