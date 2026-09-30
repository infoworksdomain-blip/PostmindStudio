import { describe, expect, it } from 'vitest';
import { calendarDaysBetween } from './calendar-days';
import { assignKinds, buildSkeleton, calendarDayName, seasonalSlots } from './mix';
import { dailySlots } from './slots';

const LONDON = 'Europe/London';

describe('20.9 month mix', () => {
  it('spreads the video share evenly', () => {
    expect(assignKinds(4, 50)).toEqual(['SLIDESHOW', 'VIDEO', 'SLIDESHOW', 'VIDEO']);
    expect(assignKinds(4, 25).filter((k) => k === 'VIDEO')).toHaveLength(1);
    expect(assignKinds(3, 0)).toEqual(['SLIDESHOW', 'SLIDESHOW', 'SLIDESHOW']);
    expect(assignKinds(3, 100)).toEqual(['VIDEO', 'VIDEO', 'VIDEO']);
    expect(assignKinds(10, 70).filter((k) => k === 'VIDEO')).toHaveLength(7);
    expect(assignKinds(2, 150)).toEqual(['VIDEO', 'VIDEO']);
  });

  it('puts one seasonal post on each calendar day, or up to 3 days before it', () => {
    const start = { year: 2026, month: 10, day: 26 };
    const slots = dailySlots(start, 11, 1, LONDON);
    const days = calendarDaysBetween(start, 11);
    const map = seasonalSlots(slots, days, LONDON);
    // 26 Oct + 5 = 31 Oct (Halloween); 26 Oct + 10 = 5 Nov (Bonfire Night).
    expect([...map.entries()]).toEqual([
      [5, 'halloween'],
      [10, 'bonfire_night'],
    ]);
    // Without a slot on the day itself, the last slot in the 3 days before is used.
    const noHalloween = slots.filter((_, i) => i !== 5);
    const shifted = seasonalSlots(noHalloween, days, LONDON);
    expect(shifted.get(4)).toBe('halloween');
  });

  it('builds a varied skeleton: no ordinary angle twice in a row', () => {
    const start = { year: 2026, month: 10, day: 1 };
    const slots = dailySlots(start, 31, 2, LONDON);
    const skeleton = buildSkeleton({
      slots,
      videoShare: 50,
      calendarDays: calendarDaysBetween(start, 31),
      timezone: LONDON,
    });
    expect(skeleton).toHaveLength(62);
    for (let i = 1; i < skeleton.length; i += 1)
      expect(skeleton[i]!.angle === skeleton[i - 1]!.angle).toBe(false);
    const seasonal = skeleton.filter((s) => s.angle === 'seasonal');
    expect(seasonal.map((s) => s.calendarDay)).toEqual(['halloween']);
    expect(new Set(skeleton.map((s) => s.angle))).toEqual(
      new Set([
        'how_to',
        'product_feature',
        'behind_the_scenes',
        'offer',
        'testimonial',
        'seasonal',
      ]),
    );
    expect(skeleton.filter((s) => s.kind === 'VIDEO')).toHaveLength(31);
  });

  it('names calendar days for the prompt', () => {
    expect(calendarDayName('halloween')).toBe('Halloween');
    expect(calendarDayName('nope')).toBeNull();
    expect(calendarDayName(null)).toBeNull();
  });
});
