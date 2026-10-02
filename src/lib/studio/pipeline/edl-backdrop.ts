import { HEX_COLOUR } from './edl-time';

// BACKLOG 20.22 — the colour behind text cards, motion-graphics cards and the timeline itself.
// Production finding (QA run 3, 2026-10-02): a TikTok video failed black_frames because its
// MOTION_GRAPHICS shot was drawn on #111111 and its TEXT_CARD on #000000 (the defaults when the
// brand kit has no colours), and a `fade` out dipped to the timeline background, which Shotstack
// defaults to black. Shotstack Edit API (https://shotstack.io/docs/api/, read 2026-10-02):
//   - Timeline `background`: "A hexadecimal value for the timeline background colour. Defaults to
//     #000000 (black)." It shows wherever no clip covers the frame: a clip fading out with no
//     overlap ("fade to and from black", https://shotstack.io/learn/how-to-fade-dissolve-video/),
//     or a video clip whose file ends before the clip's length;
//   - HtmlAsset `background`: a colour behind the HTML bounding box (the text-card fill);
//   - ShapeAsset `fill.color` (the motion-graphics background rectangle).
// So every one of those surfaces gets a designed, non-black colour: the brand's own background
// colour when it is light enough, the same hue lifted towards white when it is too dark, and a
// neutral slate when the brand kit sets no colour.
//
// "Light enough" is measured the way ffmpeg blackdetect measures it (libavfilter
// vf_blackdetect.c): a pixel is black when its luma is under pix_th of the luma range, i.e.
// 16 + 0.10 × 219 ≈ 38 on limited-range video (25.5 on full range). MIN_BACKDROP_LUMA = 0.2
// (51/255 full range, ≈ 60 limited range) keeps every backdrop well clear of that threshold,
// including after H.264 compression noise.

/** Lowest Rec. 709 luma (0–1) a backdrop may have: twice blackdetect's pix_th of 0.10. */
export const MIN_BACKDROP_LUMA = 0.2;
/** Neutral slate used when the brand kit sets no background colour (luma ≈ 0.25). */
export const DEFAULT_BACKDROP = '#3A4150';
/** WCAG 2.x minimum contrast for card text (AA, normal text). */
export const MIN_TEXT_CONTRAST = 4.5;
const LIGHT_TEXT = '#FFFFFF';
const DARK_TEXT = '#111111';

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => Math.min(255, Math.max(0, c)).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** Rec. 709 luma Y′ (0–1) of a #RRGGBB colour, from its gamma-encoded channels (as video is). */
export function lumaOf(hex: string): number {
  const [r, g, b] = channels(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** True when blackdetect could read this colour as black (luma under MIN_BACKDROP_LUMA). */
export function isTooDark(hex: string): boolean {
  // The epsilon absorbs floating-point error (the weights sum to 1, but 51 × them is 50.999…).
  return lumaOf(hex) < MIN_BACKDROP_LUMA - 1e-9;
}

/**
 * The colour mixed towards white just far enough to reach MIN_BACKDROP_LUMA. Luma is linear in
 * the mix, so the factor is exact; channels are rounded up so rounding never lands below it.
 */
function lift(hex: string): string {
  const y = lumaOf(hex);
  const t = (MIN_BACKDROP_LUMA - y) / (1 - y);
  return toHex(channels(hex).map((c) => Math.ceil(c + (255 - c) * t)) as [number, number, number]);
}

/** The card/timeline backdrop for a brand background colour (absent or invalid → slate). */
export function backdropColour(brandBackground: string | undefined): string {
  if (!brandBackground || !HEX_COLOUR.test(brandBackground)) return DEFAULT_BACKDROP;
  return isTooDark(brandBackground) ? lift(brandBackground) : brandBackground;
}

/** WCAG relative luminance (linearised sRGB). */
function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #RRGGBB colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Text colour for a backdrop: the brand's text colour when it reads clearly on it (WCAG AA),
 * otherwise white or near-black, whichever contrasts more.
 */
export function readableTextColour(backdrop: string, preferred: string | undefined): string {
  if (
    preferred &&
    HEX_COLOUR.test(preferred) &&
    contrastRatio(preferred, backdrop) >= MIN_TEXT_CONTRAST
  )
    return preferred;
  return contrastRatio(LIGHT_TEXT, backdrop) >= contrastRatio(DARK_TEXT, backdrop)
    ? LIGHT_TEXT
    : DARK_TEXT;
}
