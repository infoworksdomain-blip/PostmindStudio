// BACKLOG 25.2 — WCAG contrast for the design tokens in src/app/globals.css, which are written as
// oklch(). OKLab → linear sRGB uses Björn Ottosson's published matrices
// (https://bottosson.github.io/posts/oklab/); relative luminance and the contrast ratio follow
// WCAG 2.2 (https://www.w3.org/TR/WCAG22/#dfn-relative-luminance). No dependencies.

export interface Oklch {
  l: number;
  c: number;
  h: number;
  /** 0–1 */
  alpha: number;
}

/** Linear-light sRGB, each channel clamped to 0–1 (out-of-gamut colours are clipped). */
export type LinearRgb = readonly [number, number, number];

const OKLCH = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?)\s*)?\)$/;

export function parseOklch(value: string): Oklch {
  const m = OKLCH.exec(value.trim());
  if (!m) throw new TypeError(`not an oklch() colour: ${value}`);
  const l = Number(m[1]) / (m[2] ? 100 : 1);
  const alpha = m[5] === undefined ? 1 : Number(m[5]) / (m[6] ? 100 : 1);
  return { l, c: Number(m[3]), h: Number(m[4]), alpha };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function oklchToLinearRgb({ l, c, h }: Oklch): LinearRgb {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const [L, M, S] = [l_ ** 3, m_ ** 3, s_ ** 3];
  return [
    clamp01(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    clamp01(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    clamp01(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
  ];
}

const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const decode = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);

/** Composites a translucent colour over an opaque one the way browsers do (in gamma sRGB). */
export function composite(fg: LinearRgb, alpha: number, bg: LinearRgb): LinearRgb {
  const mix = (f: number, b: number) => decode(encode(f) * alpha + encode(b) * (1 - alpha));
  return [mix(fg[0], bg[0]), mix(fg[1], bg[1]), mix(fg[2], bg[2])];
}

export function relativeLuminance([r, g, b]: LinearRgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1–21) of a foreground, possibly translucent, over an opaque background. */
export function contrastRatio(foreground: string, background: string): number {
  const bg = parseOklch(background);
  if (bg.alpha < 1) throw new TypeError(`background must be opaque: ${background}`);
  const bgRgb = oklchToLinearRgb(bg);
  const fg = parseOklch(foreground);
  const fgRgb =
    fg.alpha < 1 ? composite(oklchToLinearRgb(fg), fg.alpha, bgRgb) : oklchToLinearRgb(fg);
  const [hi, lo] = [relativeLuminance(fgRgb), relativeLuminance(bgRgb)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
