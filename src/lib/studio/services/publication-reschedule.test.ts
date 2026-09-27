import { describe, expect, it } from 'vitest';
import {
  assertRescheduleWindow,
  fireJobIdFor,
  MAX_RESCHEDULE_AHEAD_MS,
  MIN_RESCHEDULE_LEAD_MS,
  reschedulePublicationInput,
} from './publication-reschedule';

const data = {
  publicationId: 'pub_1',
  projectId: 'prj',
  organisationId: 'org',
  runId: 'run',
  planTier: 'STANDARD' as const,
};

describe('publication reschedule helpers', () => {
  it('fire job ids are per scheduled time', () => {
    const a = fireJobIdFor(data, new Date('2026-10-03T08:30:00Z'));
    const b = fireJobIdFor(data, new Date('2026-10-04T08:30:00Z'));
    expect(a).toBe(`fire-scheduled__pub_1__${Date.parse('2026-10-03T08:30:00Z')}`);
    expect(a).not.toBe(b);
  });

  it('accepts 1 minute – 180 days ahead only', () => {
    const now = 1_000_000;
    expect(() => assertRescheduleWindow(new Date(now + MIN_RESCHEDULE_LEAD_MS), now)).not.toThrow();
    expect(() =>
      assertRescheduleWindow(new Date(now + MAX_RESCHEDULE_AHEAD_MS), now),
    ).not.toThrow();
    expect(() => assertRescheduleWindow(new Date(now + 59_000), now)).toThrow('1 minute');
    expect(() => assertRescheduleWindow(new Date(now + MAX_RESCHEDULE_AHEAD_MS + 1), now)).toThrow(
      '180 days',
    );
    expect(() => assertRescheduleWindow(new Date(Number.NaN), now)).toThrow();
  });

  it('the body is exactly { scheduledFor: ISO datetime }', () => {
    expect(
      reschedulePublicationInput.safeParse({ scheduledFor: '2026-10-03T08:30:00Z' }).success,
    ).toBe(true);
    expect(reschedulePublicationInput.safeParse({ scheduledFor: 'soon' }).success).toBe(false);
    expect(
      reschedulePublicationInput.safeParse({ scheduledFor: '2026-10-03T08:30:00Z', state: 'x' })
        .success,
    ).toBe(false);
  });
});
