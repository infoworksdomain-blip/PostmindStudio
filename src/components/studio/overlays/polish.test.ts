import { describe, expect, it } from 'vitest';
import { joinHex, splitHex } from './colour';
import {
  commit,
  emptyHistory,
  HISTORY_LIMIT,
  historyKey,
  redo,
  undo,
  withChange,
  without,
} from './draft-history';
import { MAX_FONT_PCT, MIN_FONT_PCT, resizedFontPct, steppedFontPct } from './resize-math';
import { insideSafeArea, SAFE_AREAS, safeAreaFor } from './safe-areas';

// 13.7 overlay editor polish: undo/redo history, colour with alpha, resize maths, safe areas.

describe('draft history', () => {
  it('undoes and redoes each change, and a new change clears redo', () => {
    let h = emptyHistory();
    h = commit(h, withChange(h.present, 'o1', { text: 'a' }));
    h = commit(h, withChange(h.present, 'o1', { fontSizePct: 9 }));
    expect(h.present).toEqual({ o1: { text: 'a', fontSizePct: 9 } });
    h = undo(h);
    expect(h.present).toEqual({ o1: { text: 'a' } });
    h = redo(h);
    expect(h.present).toEqual({ o1: { text: 'a', fontSizePct: 9 } });
    h = undo(undo(h));
    expect(h.present).toEqual({});
    expect(undo(h)).toBe(h);
    h = commit(h, without(withChange(h.present, 'o2', { text: 'b' }), 'o3'));
    expect(h.future).toEqual([]);
    expect(redo(h)).toBe(h);
  });

  it('keeps at most HISTORY_LIMIT steps', () => {
    let h = emptyHistory();
    for (let i = 0; i < HISTORY_LIMIT + 20; i += 1)
      h = commit(h, withChange(h.present, 'o', { fontSizePct: i }));
    expect(h.past).toHaveLength(HISTORY_LIMIT);
  });

  it('maps keyboard shortcuts', () => {
    const k = (
      key: string,
      mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }>,
    ) => historyKey({ key, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });
    expect(k('z', { ctrlKey: true })).toBe('undo');
    expect(k('Z', { metaKey: true, shiftKey: true })).toBe('redo');
    expect(k('y', { ctrlKey: true })).toBe('redo');
    expect(k('z', {})).toBeNull();
    expect(k('s', { ctrlKey: true })).toBeNull();
  });
});

describe('colour with transparency', () => {
  it('splits and joins #rrggbb[aa]', () => {
    expect(splitHex('#FF000080', '#ffffff')).toEqual({ rgb: '#ff0000', alpha: 0.5 });
    expect(splitHex('#00ff00', '#ffffff')).toEqual({ rgb: '#00ff00', alpha: 1 });
    expect(splitHex(null, '#123456')).toEqual({ rgb: '#123456', alpha: 1 });
    expect(joinHex('#FF0000', 1)).toBe('#ff0000');
    expect(joinHex('#ff0000', 0.5)).toBe('#ff000080');
    expect(joinHex('#ff0000', 0)).toBe('#ff000000');
    expect(joinHex('#ff0000', 2)).toBe('#ff0000');
  });
});

describe('resize handles', () => {
  it('scales the font with the drag and clamps it', () => {
    expect(resizedFontPct(10, 100, 0, 50)).toBe(15);
    expect(resizedFontPct(10, 100, 0, -50)).toBe(5);
    expect(resizedFontPct(10, 100, 30, 5)).toBe(13);
    expect(resizedFontPct(30, 100, 0, 500)).toBe(MAX_FONT_PCT);
    expect(resizedFontPct(2, 100, 0, -99)).toBe(MIN_FONT_PCT);
  });

  it('steps with arrow keys', () => {
    expect(steppedFontPct(10, 'ArrowUp')).toBe(10.5);
    expect(steppedFontPct(10, 'ArrowLeft')).toBe(9.5);
    expect(steppedFontPct(10, 'Enter')).toBeNull();
  });
});

describe('safe areas', () => {
  it('uses Meta’s published Reels zone and labels the rest as conservative', () => {
    expect(SAFE_AREAS.instagram_reel).toMatchObject({
      top: 0.14,
      bottom: 0.35,
      left: 0.06,
      right: 0.06,
      official: true,
    });
    expect(safeAreaFor('tiktok', '9:16')?.official).toBe(false);
    expect(safeAreaFor('tiktok', '9:16')?.label).toMatch(/conservative/);
    expect(safeAreaFor('youtube', '16:9')).toMatchObject({ top: 0.05, official: false });
    expect(safeAreaFor('unknown', '9:16')).toBeNull();
  });

  it('never applies vertical-feed margins to a landscape frame', () => {
    expect(safeAreaFor('facebook', '16:9')).toMatchObject({ bottom: 0.05, official: false });
  });

  it('tells whether an anchor is inside', () => {
    const area = SAFE_AREAS.instagram_reel;
    if (!area) throw new Error('missing');
    expect(insideSafeArea(area, 0.5, 0.5)).toBe(true);
    expect(insideSafeArea(area, 0.5, 0.9)).toBe(false);
  });
});
