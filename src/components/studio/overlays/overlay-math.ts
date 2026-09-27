import { STYLE_KEYS, type EditableStyle, type Overlay, type OverlayDraft } from './types';

// Pure timing / position / diff helpers for the overlay editor (unit-tested).

export const MIN_OVERLAY_SEC = 0.2;
/** Centre and rule-of-thirds guides (A4.1 snap-to guides). */
export const GUIDES = [1 / 3, 0.5, 2 / 3];
const SNAP_DISTANCE = 0.025;

const round = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export interface Timing {
  startAtSec: number;
  endAtSec: number;
}

/** Shift the whole bar, keeping its length, inside [0, duration]. */
export function moveTiming(t: Timing, deltaSec: number, duration: number): Timing {
  const length = t.endAtSec - t.startAtSec;
  const start = clamp(t.startAtSec + deltaSec, 0, Math.max(0, duration - length));
  return { startAtSec: round(start), endAtSec: round(start + length) };
}

/** Drag one end; the overlay never gets shorter than MIN_OVERLAY_SEC or leaves the shot. */
export function resizeTiming(
  t: Timing,
  edge: 'start' | 'end',
  deltaSec: number,
  duration: number,
): Timing {
  if (edge === 'start') {
    const start = clamp(t.startAtSec + deltaSec, 0, t.endAtSec - MIN_OVERLAY_SEC);
    return { startAtSec: round(start), endAtSec: t.endAtSec };
  }
  const end = clamp(t.endAtSec + deltaSec, t.startAtSec + MIN_OVERLAY_SEC, duration);
  return { startAtSec: t.startAtSec, endAtSec: round(end) };
}

/** Snap a 0–1 anchor to the nearest guide when close enough. */
export function snapAnchor(value: number): number {
  const v = clamp(value, 0, 1);
  const guide = GUIDES.find((g) => Math.abs(g - v) <= SNAP_DISTANCE);
  return round(guide ?? v);
}

/** A default 2-second window starting at the playhead (or at 0 near the end of the shot). */
export function newOverlayTiming(playhead: number, duration: number): Timing {
  const length = Math.min(2, duration);
  const start = playhead + MIN_OVERLAY_SEC > duration ? 0 : playhead;
  return { startAtSec: round(start), endAtSec: round(Math.min(duration, start + length)) };
}

export function isActiveAt(t: Timing, time: number): boolean {
  return time >= t.startAtSec && time < t.endAtSec;
}

export function applyDraft(overlay: Overlay, draft: OverlayDraft | undefined): Overlay {
  return draft ? { ...overlay, ...draft } : overlay;
}

export interface OverlayPatch {
  text?: string;
  startAtSec?: number;
  endAtSec?: number;
  style?: Partial<EditableStyle>;
}

/** PATCH /overlays/:id body with only what changed (null when nothing did). */
export function buildPatch(overlay: Overlay, draft: OverlayDraft | undefined): OverlayPatch | null {
  if (!draft) return null;
  const patch: OverlayPatch = {};
  if (draft.text !== undefined && draft.text.trim() !== overlay.text)
    patch.text = draft.text.trim();
  if (draft.startAtSec !== undefined && draft.startAtSec !== overlay.startAtSec)
    patch.startAtSec = draft.startAtSec;
  if (draft.endAtSec !== undefined && draft.endAtSec !== overlay.endAtSec)
    patch.endAtSec = draft.endAtSec;
  const style: Partial<EditableStyle> = {};
  for (const key of STYLE_KEYS) {
    const next = draft[key];
    if (next !== undefined && next !== overlay[key]) Object.assign(style, { [key]: next });
  }
  if (Object.keys(style).length) patch.style = style;
  return Object.keys(patch).length ? patch : null;
}

/** The overlay's style as preset parameters ("save the current settings as a new preset"). */
export function styleOf(overlay: Overlay): Partial<EditableStyle> {
  const out: Partial<EditableStyle> = {};
  for (const key of STYLE_KEYS) Object.assign(out, { [key]: overlay[key] });
  return out;
}

/** Validation the API would otherwise reject with a 400. */
export function draftProblems(overlay: Overlay, duration: number): string[] {
  const problems: string[] = [];
  if (!overlay.text.trim()) problems.push('Text can’t be empty.');
  if (overlay.endAtSec <= overlay.startAtSec) problems.push('End must be after start.');
  if (overlay.endAtSec > duration + 1e-6)
    problems.push(`End must be within the shot’s ${duration}s.`);
  if (!/^[A-Za-z0-9 -]{1,64}$/.test(overlay.fontFamily.trim()))
    problems.push('Font must be a Google Fonts family name.');
  return problems;
}
