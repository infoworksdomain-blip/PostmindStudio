import { describe, expect, it } from 'vitest';
import { DURATION_TOLERANCE_SEC } from './quality-checks';
import {
  MIN_DISPLAY_SEC,
  READING_WORDS_PER_SEC,
  donorFloorSec,
  rebalanceShots,
  type RebalanceShot,
} from './shot-rebalance';

// 21.1 — give overrunning narration time from other shots before it is trimmed.

const shot = (over: Partial<RebalanceShot> & { id: string }): RebalanceShot => ({
  durationSec: 3,
  voiceSec: null,
  trimmed: false,
  unmeasured: false,
  maxVisualSec: Number.POSITIVE_INFINITY,
  canDonate: true,
  overlayHoldSec: 0,
  readingWords: 0,
  ...over,
});

const total = (shots: RebalanceShot[], durations: Record<string, number>) =>
  Math.round(shots.reduce((sum, s) => sum + (durations[s.id] ?? s.durationSec), 0) * 1000) / 1000;

describe('rebalanceShots', () => {
  it('production QA run 8: the 2.5 s still holds its 2.741 s line, nothing is trimmed', () => {
    const target = 15;
    const shots = [
      shot({ id: 'hook', durationSec: 3, voiceSec: 2.2, maxVisualSec: 5 }),
      shot({ id: 'still', durationSec: 2.5, voiceSec: 2.741, trimmed: true }),
      shot({ id: 'card', durationSec: 3, readingWords: 3 }),
      shot({ id: 'demo', durationSec: 4, voiceSec: 3.5, maxVisualSec: 5 }),
      shot({ id: 'cta', durationSec: 3, voiceSec: 2.6 }),
    ];
    const plan = rebalanceShots(shots, { budgetSec: 0 });
    expect(plan.unresolved).toEqual([]);
    expect(plan.durations).toEqual({ still: 3, card: 2.5 });
    expect(plan.lengthened).toEqual([
      {
        shotId: 'still',
        fromSec: 2.5,
        toSec: 3,
        donors: [{ shotId: 'card', sec: 0.5 }],
        budgetSec: 0,
      },
    ]);
    // The script keeps its length, so the ±2 s duration check is unaffected.
    expect(total(shots, plan.durations)).toBe(15.5);
    expect(Math.abs(total(shots, plan.durations) - target)).toBeLessThanOrEqual(
      DURATION_TOLERANCE_SEC,
    );
  });

  it('takes from the nearest shots first, the following one before the preceding one', () => {
    const shots = [
      shot({ id: 'a', durationSec: 4 }),
      shot({ id: 'b', durationSec: 4 }),
      shot({ id: 'over', durationSec: 2, voiceSec: 2.9, trimmed: true }),
      shot({ id: 'c', durationSec: 1.5 }),
      shot({ id: 'd', durationSec: 4 }),
    ];
    const plan = rebalanceShots(shots, { budgetSec: 0 });
    // Needs 1.1 s: c (next, 0.3 s above the 1.2 s minimum), then b (previous), not a or d.
    expect(plan.lengthened[0]?.donors).toEqual([
      { shotId: 'c', sec: 0.3 },
      { shotId: 'b', sec: 0.8 },
    ]);
    expect(plan.durations).toEqual({ over: 3.1, c: 1.2, b: 3.2 });
    expect(total(shots, plan.durations)).toBe(total(shots, {}));
  });

  it('never takes a donor below its narration + tail, overlays, reading time or 1.2 s', () => {
    expect(donorFloorSec(shot({ id: 'x', voiceSec: 2.5 }))).toBeCloseTo(2.7);
    expect(donorFloorSec(shot({ id: 'x', voiceSec: 0.4 }))).toBe(MIN_DISPLAY_SEC);
    expect(donorFloorSec(shot({ id: 'x', overlayHoldSec: 2.4 }))).toBe(2.4);
    expect(donorFloorSec(shot({ id: 'x', readingWords: 9 }))).toBe(9 / READING_WORDS_PER_SEC);
    // Narrated shots are read along with the voice: reading time does not apply.
    expect(donorFloorSec(shot({ id: 'x', voiceSec: 1, readingWords: 9 }))).toBe(MIN_DISPLAY_SEC);

    const shots = [
      shot({ id: 'over', durationSec: 2, voiceSec: 2.4, trimmed: true }), // needs 0.6 s
      shot({ id: 'voiced', durationSec: 3, voiceSec: 2.6 }), // 0.2 s slack
      shot({ id: 'overlay', durationSec: 3, overlayHoldSec: 2.9 }), // 0.1 s slack
      shot({ id: 'text', durationSec: 3, readingWords: 8 }), // 0.33 s slack
    ];
    const plan = rebalanceShots(shots, { budgetSec: 0 });
    expect(plan.durations).toEqual({ over: 2.6, voiced: 2.8, overlay: 2.9, text: 2.7 });
    // 0.7 s needed, 0.63 s available: nothing moves.
    const more = rebalanceShots(
      shots.map((s) => (s.id === 'over' ? { ...s, voiceSec: 2.5 } : s)),
      { budgetSec: 0 },
    );
    expect(more.durations).toEqual({});
  });

  it('spends the script head-room only when donors cannot cover the shortfall', () => {
    const shots = [
      shot({ id: 'over', durationSec: 2, voiceSec: 2.6, trimmed: true }),
      shot({ id: 'tight', durationSec: 1.5 }),
    ];
    const plan = rebalanceShots(shots, { budgetSec: 1 });
    expect(plan.lengthened[0]).toMatchObject({
      donors: [{ shotId: 'tight', sec: 0.3 }],
      budgetSec: 0.5,
    });
    expect(plan.budgetUsedSec).toBe(0.5);
    expect(plan.durations).toEqual({ over: 2.8, tight: 1.2 });
  });

  it('changes nothing when the whole shortfall cannot be found (a partial fix would still cut)', () => {
    const shots = [
      shot({ id: 'over', durationSec: 2, voiceSec: 3.5, trimmed: true }),
      shot({ id: 'small', durationSec: 2 }),
    ];
    const plan = rebalanceShots(shots, { budgetSec: 0.5 });
    expect(plan).toEqual({ durations: {}, lengthened: [], unresolved: ['over'], budgetUsedSec: 0 });
  });

  it('lengthens a video shot only when its stored clip runs long enough', () => {
    const donor = shot({ id: 'card', durationSec: 4 });
    const clip = (maxVisualSec: number | null) => [
      shot({ id: 'clip', durationSec: 2.5, voiceSec: 2.741, trimmed: true, maxVisualSec }),
      donor,
    ];
    // A 5 s provider clip made for a 2.5 s shot simply plays longer.
    expect(rebalanceShots(clip(5), { budgetSec: 0 }).durations).toEqual({ clip: 3, card: 3.5 });
    expect(rebalanceShots(clip(3), { budgetSec: 0 }).durations).toEqual({ clip: 3, card: 3.5 });
    expect(rebalanceShots(clip(2.8), { budgetSec: 0 }).unresolved).toEqual(['clip']);
    expect(rebalanceShots(clip(null), { budgetSec: 0 }).unresolved).toEqual(['clip']);
  });

  it('never takes time from trimmed, unmeasured or protected shots', () => {
    const shots = [
      shot({ id: 'over', durationSec: 2, voiceSec: 2.6, trimmed: true }),
      shot({ id: 'other', durationSec: 5, voiceSec: 5.5, trimmed: true, maxVisualSec: null }),
      shot({ id: 'unknown', durationSec: 5, voiceSec: null, unmeasured: true }),
      shot({ id: 'upload', durationSec: 5, canDonate: false }),
    ];
    const plan = rebalanceShots(shots, { budgetSec: 0 });
    expect(plan.durations).toEqual({});
    expect(plan.unresolved).toEqual(['over', 'other']);
  });

  it('serves several trimmed shots in script order from shared slack, deterministically', () => {
    const shots = [
      shot({ id: 'one', durationSec: 2, voiceSec: 2.3, trimmed: true }),
      shot({ id: 'donor', durationSec: 2 }),
      shot({ id: 'two', durationSec: 2, voiceSec: 2.3, trimmed: true }),
    ];
    const plan = rebalanceShots(shots, { budgetSec: 0 });
    // 0.8 s of slack: "one" needs 0.5 s, "two" then finds only 0.3 s and stays trimmed.
    expect(plan.durations).toEqual({ one: 2.5, donor: 1.5 });
    expect(plan.unresolved).toEqual(['two']);
    expect(rebalanceShots(shots, { budgetSec: 0 })).toEqual(plan);
  });

  it('leaves a trimmed shot alone when its narration needs no more time', () => {
    const shots = [
      shot({ id: 'fine', durationSec: 3, voiceSec: 2.7, trimmed: true }),
      shot({ id: 'donor', durationSec: 3 }),
    ];
    expect(rebalanceShots(shots, { budgetSec: 0 })).toMatchObject({
      durations: {},
      unresolved: ['fine'],
    });
  });
});
