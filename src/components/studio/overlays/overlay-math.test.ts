import { describe, expect, it } from 'vitest';
import {
  buildPatch,
  draftProblems,
  moveTiming,
  newOverlayTiming,
  resizeTiming,
  snapAnchor,
  styleOf,
} from './overlay-math';
import { makeOverlay } from './test-fixtures';

describe('timing', () => {
  it('moves a bar without leaving the shot', () => {
    expect(moveTiming({ startAtSec: 1, endAtSec: 3 }, 0.5, 5)).toEqual({
      startAtSec: 1.5,
      endAtSec: 3.5,
    });
    expect(moveTiming({ startAtSec: 1, endAtSec: 3 }, 10, 5)).toEqual({
      startAtSec: 3,
      endAtSec: 5,
    });
    expect(moveTiming({ startAtSec: 1, endAtSec: 3 }, -10, 5)).toEqual({
      startAtSec: 0,
      endAtSec: 2,
    });
  });

  it('resizes an end but keeps a minimum length', () => {
    expect(resizeTiming({ startAtSec: 1, endAtSec: 3 }, 'end', 1, 5).endAtSec).toBe(4);
    expect(resizeTiming({ startAtSec: 1, endAtSec: 3 }, 'end', -5, 5).endAtSec).toBe(1.2);
    expect(resizeTiming({ startAtSec: 1, endAtSec: 3 }, 'start', 5, 5).startAtSec).toBe(2.8);
    expect(resizeTiming({ startAtSec: 1, endAtSec: 3 }, 'end', 5, 5).endAtSec).toBe(5);
  });

  it('places a new overlay at the playhead', () => {
    expect(newOverlayTiming(1, 5)).toEqual({ startAtSec: 1, endAtSec: 3 });
    expect(newOverlayTiming(4.9, 5)).toEqual({ startAtSec: 0, endAtSec: 2 });
    expect(newOverlayTiming(0, 1.5)).toEqual({ startAtSec: 0, endAtSec: 1.5 });
  });
});

describe('snapAnchor', () => {
  it('snaps to centre and thirds when close', () => {
    expect(snapAnchor(0.51)).toBe(0.5);
    expect(snapAnchor(0.34)).toBe(0.33);
    expect(snapAnchor(0.8)).toBe(0.8);
    expect(snapAnchor(1.4)).toBe(1);
  });
});

describe('buildPatch', () => {
  it('returns null when nothing changed', () => {
    const o = makeOverlay();
    expect(buildPatch(o, undefined)).toBeNull();
    expect(buildPatch(o, { text: o.text, fontWeight: o.fontWeight })).toBeNull();
  });

  it('sends only changed text, timing and style', () => {
    const o = makeOverlay();
    expect(
      buildPatch(o, { text: ' Hi ', endAtSec: 4, fillColor: '#ff0000', anchorX: o.anchorX }),
    ).toEqual({ text: 'Hi', endAtSec: 4, style: { fillColor: '#ff0000' } });
  });
});

describe('styleOf / draftProblems', () => {
  it('extracts the editable style', () => {
    const style = styleOf(makeOverlay());
    expect(style.fontFamily).toBe('Montserrat');
    expect(style).not.toHaveProperty('text');
  });

  it('flags invalid drafts', () => {
    const problems = draftProblems(
      makeOverlay({ text: ' ', startAtSec: 3, endAtSec: 2, fontFamily: 'Bad;font' }),
      5,
    );
    expect(problems).toHaveLength(3);
    expect(draftProblems(makeOverlay({ endAtSec: 9 }), 5)).toEqual([
      'End must be within the shot’s 5s.',
    ]);
  });
});
