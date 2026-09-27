// Phase 13.7 — resize handles: dragging the selected overlay's corner scales its font size in
// proportion to how far the text box grows. Pure for unit tests.

export const MIN_FONT_PCT = 1;
export const MAX_FONT_PCT = 40;
/** Arrow keys on the handle change the size by this much (keyboard alternative to dragging). */
export const KEY_STEP_PCT = 0.5;

const clampPct = (n: number) =>
  Math.round(Math.min(MAX_FONT_PCT, Math.max(MIN_FONT_PCT, n)) * 2) / 2;

/** New fontSizePct after dragging the corner by (dx, dy) px from a box of startHeight px. */
export function resizedFontPct(
  startPct: number,
  startHeightPx: number,
  dx: number,
  dy: number,
): number {
  const base = Math.max(8, startHeightPx);
  // Diagonal drags count once: use the larger of the two movements, signed.
  const delta = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
  return clampPct(startPct * ((base + delta) / base));
}

export function steppedFontPct(current: number, key: string): number | null {
  if (key === 'ArrowUp' || key === 'ArrowRight') return clampPct(current + KEY_STEP_PCT);
  if (key === 'ArrowDown' || key === 'ArrowLeft') return clampPct(current - KEY_STEP_PCT);
  return null;
}
