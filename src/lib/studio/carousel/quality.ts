// Quality checks for rendered carousel slides (21.6): text inside the safe area, no overflow,
// pictures not stretched, readable contrast (WCAG 2.2 AA, 4.5:1 for body text).
// Contrast formula: https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio and relative luminance
// https://www.w3.org/TR/WCAG22/#dfn-relative-luminance (read 2026-10-04).
import { SAFE_X, SAFE_Y, SLIDE_HEIGHT, SLIDE_WIDTH } from './constants';
import type { SlideLayout } from './layout';

export const WCAG_AA_TEXT = 4.5;

function channel(hex: string, offset: number): number {
  const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a #RRGGBB colour. */
export function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new RangeError(`not a #RRGGBB colour: ${hex}`);
  return 0.2126 * channel(h, 0) + 0.7152 * channel(h, 2) + 0.0722 * channel(h, 4);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export type SlideIssueCode =
  | 'text_outside_safe_area'
  | 'content_overflow'
  | 'image_stretched'
  | 'low_contrast'
  | 'hook_without_image';

export interface SlideIssue {
  readonly slide: number;
  readonly code: SlideIssueCode;
  readonly detail: string;
}

/** Measured ink of a text element after rendering (width/height in px). */
export interface RenderedText {
  readonly elementIndex: number;
  readonly width: number;
}

/** Aspect ratio of a picture as drawn vs its source; 1% tolerance for rounding to whole pixels. */
export function isStretched(
  source: { width: number; height: number },
  drawn: { width: number; height: number },
): boolean {
  const a = source.width / source.height;
  const b = drawn.width / drawn.height;
  return Math.abs(a - b) / a > 0.01;
}

export interface CheckInput {
  readonly slide: number;
  readonly layout: SlideLayout;
  /** Real ink widths from the renderer; falls back to the layout's estimate. */
  readonly rendered?: readonly RenderedText[];
  /** Source sizes of the pictures by imageId. */
  readonly sources?: ReadonlyMap<string, { width: number; height: number }>;
}

/** Problems on one rendered slide (empty when it passes). */
export function checkSlide(input: CheckInput): SlideIssue[] {
  const { layout, slide } = input;
  const issues: SlideIssue[] = [];
  const renderedWidth = new Map(input.rendered?.map((r) => [r.elementIndex, r.width]));
  if (layout.contentTop + layout.contentHeight > SLIDE_HEIGHT - SAFE_Y) {
    issues.push({
      slide,
      code: 'content_overflow',
      detail: `content ends at ${layout.contentTop + layout.contentHeight}px`,
    });
  }
  layout.elements.forEach((el, index) => {
    if (el.type === 'text') {
      const width = renderedWidth.get(index) ?? el.width;
      const left = el.align === 'left' ? el.x : el.x - width;
      const right = el.align === 'left' ? el.x + width : el.x;
      // 2 px tolerance: glyph side bearings are not part of the measured advance.
      if (left < SAFE_X - 2 || right > SLIDE_WIDTH - SAFE_X + 2 || el.y < SAFE_Y) {
        issues.push({
          slide,
          code: 'text_outside_safe_area',
          detail: `"${el.text.slice(0, 40)}" spans ${Math.round(left)}–${Math.round(right)}px`,
        });
      }
      const ratio = contrastRatio(el.colour, layout.background);
      if (ratio < WCAG_AA_TEXT) {
        issues.push({ slide, code: 'low_contrast', detail: `${el.role} ${ratio.toFixed(2)}:1` });
      }
    } else if (el.type === 'image') {
      const source = input.sources?.get(el.imageId);
      if (source && isStretched(source, el)) {
        issues.push({ slide, code: 'image_stretched', detail: el.imageId });
      }
    }
  });
  return issues;
}
