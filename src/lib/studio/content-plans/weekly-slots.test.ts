import { describe, expect, it } from 'vitest';
import { weekPattern, weeklySlots } from './weekly-slots';
import { localDateOf } from './slots';

describe('N posts a week', () => {
  it('spreads posts over the week', () => {
    expect(weekPattern(3)).toEqual([
      { day: 0, posts: 1 },
      { day: 2, posts: 1 },
      { day: 4, posts: 1 },
    ]);
    expect(weekPattern(7).map((d) => d.day)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(weekPattern(8).find((d) => d.day === 0)?.posts).toBe(2);
    expect(weekPattern(21).every((d) => d.posts === 3)).toBe(true);
  });

  it('makes perWeek posts per week over 4 weeks', () => {
    const start = { year: 2026, month: 10, day: 12 };
    const slots = weeklySlots(start, 28, 3, 'Europe/London');
    expect(slots).toHaveLength(12);
    const days = slots.map((at) => localDateOf(at, 'Europe/London').day);
    expect(days.slice(0, 3)).toEqual([12, 14, 16]);
  });
});
