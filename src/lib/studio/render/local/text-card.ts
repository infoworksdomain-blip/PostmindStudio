import { RIGHT_TO_LEFT_MARK } from '../../overlays/script-fonts';
import {
  asNumber,
  asRecord,
  asString,
  parseColour,
  unescapeHtml,
  unsupported,
  type Json,
  type Rgba,
} from './edit-json';

// BACKLOG 23.5 — the text the composer puts on a Shotstack timeline, as a box the local renderer
// draws itself (text-image.ts). Two asset types reach here, both written by Studio's own builders:
//   - `html` (slideshow/edl.ts cards, captions, BEFORE/AFTER labels, headline dims;
//     pipeline/ai-label.ts): `<p>` text with optional `<small>` lines and a fixed CSS subset.
//     Shotstack HtmlAsset (https://shotstack.io/docs/api/, read 2026-10-06): `width`/`height` are
//     the bounding box ("Text will wrap to fill the bounding box", masked beyond its height),
//     `background` fills the box (8-digit hex is alpha first) and `position` places the HTML
//     inside the box.
//   - `rich-text` (overlays/shotstack.ts: text overlays, the wall-of-text block): font, stroke,
//     shadow, background, align and line height fields; the clip's width/height are the box.

export type BoxPosition =
  | 'center'
  | 'top'
  | 'topRight'
  | 'right'
  | 'bottomRight'
  | 'bottom'
  | 'bottomLeft'
  | 'left'
  | 'topLeft';

export const BOX_POSITIONS: readonly BoxPosition[] = [
  'center',
  'top',
  'topRight',
  'right',
  'bottomRight',
  'bottom',
  'bottomLeft',
  'left',
  'topLeft',
];

export function boxPosition(value: unknown, fallback: BoxPosition = 'center'): BoxPosition {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (BOX_POSITIONS as readonly string[]).includes(value))
    return value as BoxPosition;
  return unsupported(`position ${String(value)}`);
}

export interface TextParagraph {
  readonly text: string;
  readonly sizePx: number;
  readonly bold: boolean;
  readonly colour: Rgba;
  readonly marginTopPx: number;
}

export interface TextCard {
  readonly width: number;
  readonly height: number;
  /** The whole box's fill (HtmlAsset `background`), or none. */
  readonly fill: Rgba | null;
  readonly fontFamily: string;
  readonly direction: 'ltr' | 'rtl';
  readonly align: 'left' | 'center' | 'right';
  /** Where the text block sits inside the box. */
  readonly anchor: BoxPosition;
  readonly paragraphs: readonly TextParagraph[];
  /** Line advance as a multiple of the font size. */
  readonly lineHeight: number;
  /** HTML collapses runs of white space (and newlines) to one space; rich-text keeps newlines. */
  readonly collapseWhitespace: boolean;
  /** A colour behind the text block: the html `p` (full box width) or rich-text background. */
  readonly blockBackground: {
    readonly colour: Rgba;
    readonly paddingPx: number;
    readonly radiusPx: number;
    readonly fullWidth: boolean;
  } | null;
  readonly stroke: { readonly widthPx: number; readonly colour: Rgba } | null;
  readonly shadow: {
    readonly offsetX: number;
    readonly offsetY: number;
    readonly blurPx: number;
    readonly colour: Rgba;
  } | null;
  /** Styling drawn approximately (recorded in the render notes). */
  readonly approximations: readonly string[];
}

/**
 * CSS "normal" line height is about 1.2 for the bundled sans faces; slideshow/edl.ts sizes its
 * boxes with 1.25, which it documents as at least the renderer's default spacing.
 */
export const DEFAULT_LINE_HEIGHT = 1.2;
/** slideshow/edl.ts `small`: 0.55em, weight 400, 0.4em above. */
const SMALL_DEFAULTS = { scale: 0.55, weight: 400, marginEm: 0.4 };
const BOLD_FROM = 600;

const P_PROPERTIES = new Set([
  'font-family',
  'color',
  'font-size',
  'font-weight',
  'text-align',
  'margin',
  'background',
  'padding',
]);
const SMALL_PROPERTIES = new Set(['display', 'font-size', 'font-weight', 'margin-top']);

/** `selector { a: b; c: d }` blocks of the composer's CSS. */
export function parseCss(css: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  for (const m of css.matchAll(/([a-z]+)\s*\{([^}]*)\}/gi)) {
    const decls = new Map<string, string>();
    for (const decl of (m[2] ?? '').split(';')) {
      const at = decl.indexOf(':');
      if (at === -1) continue;
      decls.set(decl.slice(0, at).trim().toLowerCase(), decl.slice(at + 1).trim());
    }
    rules.set((m[1] ?? '').toLowerCase(), decls);
  }
  return rules;
}

function px(value: string | undefined, name: string): number {
  const m = value ? /^(\d+(?:\.\d+)?)px$/.exec(value) : null;
  if (!m) return unsupported(`html ${name} ${value ?? '(missing)'}`);
  return Number(m[1]);
}

function em(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const m = /^(\d+(?:\.\d+)?)em$/.exec(value);
  if (!m) return unsupported(`html ${name} ${value}`);
  return Number(m[1]);
}

function weight(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (value === 'bold') return 700;
  if (value === 'normal') return 400;
  const n = Number(value);
  return Number.isFinite(n) ? n : unsupported(`font-weight ${value}`);
}

function firstFamily(value: string | undefined): string {
  const m = value ? /^'([^']+)'|^"([^"]+)"|^([A-Za-z0-9 -]+)/.exec(value) : null;
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? 'Inter').trim();
}

function align(value: string | undefined): TextCard['align'] {
  if (value === undefined || value === 'center') return 'center';
  if (value === 'left' || value === 'right') return value;
  return unsupported(`text-align ${value}`);
}

function colour(value: string | undefined, fallback: Rgba): Rgba {
  if (value === undefined) return fallback;
  return parseColour(value) ?? unsupported(`colour ${value}`);
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

/** The paragraphs of the composer's `<p>…<small>…</small></p>` markup. */
export function parseHtmlBody(html: string): {
  rtl: boolean;
  main: string;
  small: string[];
} {
  const m = /^<p( dir="rtl")?>([\s\S]*)<\/p>$/.exec(html.trim());
  if (!m) return unsupported('html markup other than one <p>');
  const inner = m[2] ?? '';
  const small: string[] = [];
  const main = inner.replace(/<small>([\s\S]*?)<\/small>/g, (_, s: string) => {
    small.push(s);
    return '';
  });
  if (/[<>]/.test(main) || small.some((s) => /[<>]/.test(s)))
    return unsupported('html tags other than <p> and <small>');
  return { rtl: Boolean(m[1]), main: unescapeHtml(main), small: small.map(unescapeHtml) };
}

/** An html asset as a text card. */
export function htmlCard(asset: Json): TextCard {
  const width = asNumber(asset.width);
  const height = asNumber(asset.height);
  if (!width || !height) return unsupported('html asset without width/height');
  const body = parseHtmlBody(asString(asset.html) ?? '');
  const css = parseCss(asString(asset.css) ?? '');
  const p = css.get('p') ?? new Map<string, string>();
  for (const key of p.keys()) {
    if (!P_PROPERTIES.has(key)) unsupported(`css p ${key}`);
  }
  const small = css.get('small') ?? new Map<string, string>();
  for (const key of small.keys()) {
    if (!SMALL_PROPERTIES.has(key)) unsupported(`css small ${key}`);
  }
  const hasText = body.main.trim().length > 0 || body.small.some((s) => s.trim());
  const sizePx = hasText ? px(p.get('font-size'), 'font-size') : 0;
  const textColour = colour(p.get('color'), WHITE);
  const bold = weight(p.get('font-weight'), 400) >= BOLD_FROM;
  const smallPx = Math.round(
    sizePx * em(small.get('font-size'), SMALL_DEFAULTS.scale, 'small size'),
  );
  const smallBold = weight(small.get('font-weight'), SMALL_DEFAULTS.weight) >= BOLD_FROM;
  const smallMargin = Math.round(
    smallPx * em(small.get('margin-top'), SMALL_DEFAULTS.marginEm, 'margin'),
  );
  const paragraphs: TextParagraph[] = [
    ...(body.main.trim()
      ? [{ text: body.main, sizePx, bold, colour: textColour, marginTopPx: 0 }]
      : []),
    ...body.small
      .filter((s) => s.trim())
      .map((text) => ({
        text,
        sizePx: smallPx,
        bold: smallBold,
        colour: textColour,
        marginTopPx: smallMargin,
      })),
  ];
  const background = p.get('background');
  const shade = background ? parseColour(background) : null;
  if (background && !shade) unsupported(`css background ${background}`);
  const padding = p.get('padding');
  const paddingPx = padding ? Math.round(sizePx * em(padding, 0, 'padding')) : 0;
  const fillValue = asString(asset.background);
  const fill = fillValue ? parseColour(fillValue, true) : null;
  if (fillValue && !fill) unsupported(`html background ${fillValue}`);
  return {
    width: Math.round(width),
    height: Math.round(height),
    fill: fill && fill.a > 0 ? fill : null,
    fontFamily: firstFamily(p.get('font-family')),
    direction: body.rtl ? 'rtl' : 'ltr',
    align: align(p.get('text-align')),
    anchor: boxPosition(asset.position),
    paragraphs,
    lineHeight: DEFAULT_LINE_HEIGHT,
    collapseWhitespace: true,
    blockBackground:
      shade && shade.a > 0 && paragraphs.length > 0
        ? { colour: shade, paddingPx, radiusPx: 0, fullWidth: true }
        : null,
    stroke: null,
    shadow: null,
    approximations: [],
  };
}

function withOpacity(c: Rgba, opacity: unknown): Rgba {
  const o = asNumber(opacity);
  return o === undefined ? c : { ...c, a: c.a * Math.min(1, Math.max(0, o)) };
}

function anchorOf(horizontal: unknown, vertical: unknown): BoxPosition {
  const h = horizontal === 'left' || horizontal === 'right' ? horizontal : 'center';
  const v = vertical === 'top' || vertical === 'bottom' ? vertical : 'middle';
  if (v === 'middle') return h === 'center' ? 'center' : h;
  if (h === 'center') return v;
  return `${v}${h === 'left' ? 'Left' : 'Right'}` as BoxPosition;
}

/** A rich-text asset in its clip's box as a text card. */
export function richTextCard(asset: Json, box: { width: number; height: number }): TextCard {
  const font = asRecord(asset.font) ?? {};
  const raw = asString(asset.text) ?? '';
  const rtl = raw.startsWith(RIGHT_TO_LEFT_MARK);
  const text = rtl ? raw.slice(RIGHT_TO_LEFT_MARK.length) : raw;
  const sizePx = asNumber(font.size);
  if (!sizePx) return unsupported('rich-text without a font size');
  const fill = withOpacity(colour(asString(font.color), WHITE), font.opacity);
  const style = asRecord(asset.style) ?? {};
  const alignment = asRecord(asset.align) ?? {};
  const approximations: string[] = [];
  if (asNumber(style.letterSpacing)) approximations.push('letter spacing not applied');
  if (font.style === 'italic') approximations.push('italic drawn upright');
  const stroke = asRecord(asset.stroke);
  const strokeWidth = asNumber(stroke?.width) ?? 0;
  const shadow = asRecord(asset.shadow);
  const background = asRecord(asset.background);
  const horizontal = alignment.horizontal ?? 'center';
  return {
    width: Math.round(box.width),
    height: Math.round(box.height),
    fill: null,
    fontFamily: asString(font.family) ?? 'Inter',
    direction: rtl ? 'rtl' : 'ltr',
    align: horizontal === 'left' || horizontal === 'right' ? horizontal : 'center',
    anchor: anchorOf(horizontal, alignment.vertical),
    paragraphs: [
      {
        text,
        sizePx,
        bold: (asNumber(font.weight) ?? 400) >= BOLD_FROM,
        colour: fill,
        marginTopPx: 0,
      },
    ],
    lineHeight: asNumber(style.lineHeight) ?? DEFAULT_LINE_HEIGHT,
    collapseWhitespace: false,
    blockBackground: background
      ? {
          colour: withOpacity(colour(asString(background.color), BLACK), background.opacity),
          paddingPx: asNumber(background.padding) ?? 0,
          radiusPx: asNumber(background.borderRadius) ?? 0,
          fullWidth: false,
        }
      : null,
    stroke:
      stroke && strokeWidth > 0
        ? {
            widthPx: strokeWidth,
            colour: withOpacity(colour(asString(stroke.color), BLACK), stroke.opacity),
          }
        : null,
    shadow: shadow
      ? {
          offsetX: asNumber(shadow.offsetX) ?? 0,
          offsetY: asNumber(shadow.offsetY) ?? 0,
          blurPx: asNumber(shadow.blur) ?? 0,
          colour: withOpacity(colour(asString(shadow.color), BLACK), shadow.opacity),
        }
      : null,
    approximations,
  };
}
