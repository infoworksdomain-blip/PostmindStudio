import type { KeyboardEvent } from 'react';

// BACKLOG 25.3 — arrow-key movement shared by SegmentedControl and ChoiceChips. The reading
// direction is read from the element itself (dir="rtl" on <html>), so in Arabic "next" is to
// the left without the primitives depending on the i18n layer.

export function isRtl(element: Element | null): boolean {
  if (!element || typeof window === 'undefined') return false;
  return window.getComputedStyle(element).direction === 'rtl';
}

/** +1 / -1 for a navigation key (Home and End jump), or null when the key is not one. */
export function rovingDelta(
  event: KeyboardEvent<HTMLElement>,
  length: number,
  current: number,
): number | null {
  const rtl = isRtl(event.currentTarget);
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
  const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
  if (event.key === forward || event.key === 'ArrowDown') return 1;
  if (event.key === backward || event.key === 'ArrowUp') return -1;
  if (event.key === 'Home') return -current;
  if (event.key === 'End') return length - 1 - current;
  return null;
}

/** The next enabled index from `from`, stepping by `delta` and wrapping round. */
export function nextEnabled(
  from: number,
  delta: number,
  disabled: readonly boolean[],
): number | null {
  const n = disabled.length;
  if (n === 0) return null;
  if (Math.abs(delta) > 1) {
    const target = Math.max(0, Math.min(n - 1, from + delta));
    const step = delta > 0 ? -1 : 1;
    for (let i = target; i >= 0 && i < n; i += step) if (!disabled[i]) return i;
    return null;
  }
  for (let k = 1; k <= n; k++) {
    const i = (((from + delta * k) % n) + n) % n;
    if (!disabled[i]) return i;
  }
  return null;
}
