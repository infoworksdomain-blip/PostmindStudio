import { describe, expect, it } from 'vitest';
import { toLocalInput } from '../calendar/month';
import { scheduleInputBounds, scheduleProblem } from './schedule-bounds';

const DAY = 86_400_000;

describe('schedule bounds (20.3)', () => {
  const now = new Date(2026, 8, 30, 10, 0).getTime();

  it('gives datetime-local min (a minute ahead) and max (180 days ahead)', () => {
    expect(scheduleInputBounds(now)).toEqual({
      min: toLocalInput(new Date(now + 60_000).toISOString()),
      max: toLocalInput(new Date(now + 180 * DAY).toISOString()),
    });
  });

  it('flags past, too-soon and too-far values', () => {
    expect(scheduleProblem('', now)).toBeNull();
    expect(scheduleProblem('not a date', now)).toBe('inPast');
    expect(scheduleProblem(toLocalInput(new Date(now - DAY).toISOString()), now)).toBe('inPast');
    expect(scheduleProblem(toLocalInput(new Date(now + 30 * DAY).toISOString()), now)).toBeNull();
    expect(scheduleProblem(toLocalInput(new Date(now + 181 * DAY).toISOString()), now)).toBe(
      'tooFar',
    );
  });
});
