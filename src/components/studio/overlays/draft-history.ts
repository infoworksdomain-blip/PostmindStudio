import type { OverlayDraft } from './types';

// Phase 13.7 — undo / redo for the overlay editor. Every local change to the drafts (style,
// timing, position, size) is a step; saving or discarding clears the redo branch. Pure and
// immutable so it is unit-tested without React.

export type Drafts = Record<string, OverlayDraft>;

export interface DraftHistory {
  past: Drafts[];
  present: Drafts;
  future: Drafts[];
}

/** Steps kept; older ones fall off so a long session cannot grow memory without bound. */
export const HISTORY_LIMIT = 100;

export const emptyHistory = (): DraftHistory => ({ past: [], present: {}, future: [] });

export function commit(history: DraftHistory, next: Drafts): DraftHistory {
  if (next === history.present) return history;
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
  };
}

export function undo(history: DraftHistory): DraftHistory {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo(history: DraftHistory): DraftHistory {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}

/** Merge a change into one overlay's draft. */
export function withChange(drafts: Drafts, id: string, change: OverlayDraft): Drafts {
  return { ...drafts, [id]: { ...drafts[id], ...change } };
}

/** Drop one overlay's draft (after save or discard). */
export function without(drafts: Drafts, id: string): Drafts {
  return Object.fromEntries(Object.entries(drafts).filter(([k]) => k !== id));
}

/** Ctrl/Cmd+Z → undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y → redo; null for any other key. */
export function historyKey(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): 'undo' | 'redo' | null {
  if (!(e.ctrlKey || e.metaKey)) return null;
  const key = e.key.toLowerCase();
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (key === 'y') return 'redo';
  return null;
}
