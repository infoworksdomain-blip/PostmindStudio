import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import {
  DEFAULT_STAGGER_MINUTES,
  DRIP_HORIZON_DAYS,
  MAX_DRIP_SLOTS,
  MAX_UPCOMING_RANGE_DAYS,
  MONTH_AHEAD_DAYS,
  dripQueueInput,
  firstFreeSlot,
  openSlotsBetween,
  parseSlots,
  publicDripQueue,
  staggerMinutes,
  unscheduledReason,
  upcomingQuery,
  upcomingSlots,
  upcomingWindow,
} from './drip-queue';

const THU = Date.parse('2026-10-01T09:00:00Z'); // Thursday
const MONDAY_0830_LONDON = { weekday: 1, time: '08:30', timezone: 'Europe/London' };

describe('drip queue slots (15.A5)', () => {
  it('lists weekly slots in the slot time zone, across the GMT change', () => {
    const slots = upcomingSlots([MONDAY_0830_LONDON], THU, 28).map((t) =>
      new Date(t).toISOString(),
    );
    expect(slots).toEqual([
      '2026-10-05T07:30:00.000Z',
      '2026-10-12T07:30:00.000Z',
      '2026-10-19T07:30:00.000Z',
      '2026-10-26T08:30:00.000Z',
    ]);
  });

  it('takes the first slot no other video holds, at least two minutes ahead', () => {
    const held = [new Date('2026-10-05T07:30:00Z')];
    expect(new Date(firstFreeSlot([MONDAY_0830_LONDON], held, THU) ?? 0).toISOString()).toBe(
      '2026-10-12T07:30:00.000Z',
    );
    const justBefore = Date.parse('2026-10-05T07:29:00Z');
    expect(new Date(firstFreeSlot([MONDAY_0830_LONDON], [], justBefore) ?? 0).toISOString()).toBe(
      '2026-10-12T07:30:00.000Z',
    );
    expect(firstFreeSlot([], [], THU)).toBeNull();
  });

  it('merges several slots in order without duplicates', () => {
    const slots = upcomingSlots(
      [MONDAY_0830_LONDON, MONDAY_0830_LONDON, { weekday: 4, time: '18:00', timezone: 'UTC' }],
      THU,
      7,
    );
    expect(slots.map((t) => new Date(t).toISOString())).toEqual([
      '2026-10-01T18:00:00.000Z',
      '2026-10-05T07:30:00.000Z',
      '2026-10-08T18:00:00.000Z',
    ]);
  });

  it('clamps the stagger to the spec 15-60 minutes', () => {
    expect(staggerMinutes({})).toBe(DEFAULT_STAGGER_MINUTES);
    expect(staggerMinutes({ STUDIO_DEFAULT_STAGGER_MINUTES: '5' })).toBe(15);
    expect(staggerMinutes({ STUDIO_DEFAULT_STAGGER_MINUTES: '90' })).toBe(60);
    expect(staggerMinutes({ STUDIO_DEFAULT_STAGGER_MINUTES: '45' })).toBe(45);
    expect(staggerMinutes({ STUDIO_DEFAULT_STAGGER_MINUTES: 'x' })).toBe(30);
  });

  it('validates input and ignores stored rows it cannot read', () => {
    expect(dripQueueInput.safeParse({ slots: [MONDAY_0830_LONDON] }).success).toBe(true);
    expect(
      dripQueueInput.safeParse({ slots: [{ ...MONDAY_0830_LONDON, time: '25:00' }] }).success,
    ).toBe(false);
    expect(
      dripQueueInput.safeParse({ slots: [{ ...MONDAY_0830_LONDON, timezone: 'Nowhere/X' }] })
        .success,
    ).toBe(false);
    expect(dripQueueInput.safeParse({ slots: [] }).success).toBe(false);
    expect(parseSlots('nonsense')).toEqual([]);
  });

  it('shapes the public view (next slot, queued count)', () => {
    const view = publicDripQueue(
      {
        slots: [MONDAY_0830_LONDON],
        platforms: ['tiktok'],
        enabled: true,
        updatedAt: new Date(THU),
      },
      [{ slotAt: new Date('2026-10-05T07:30:00Z'), projectId: 'p1' }],
      THU,
    );
    expect(view).toMatchObject({
      nextSlotAt: '2026-10-12T07:30:00.000Z',
      queued: 1,
      platforms: ['tiktok'],
    });
    const off = publicDripQueue(
      { slots: [MONDAY_0830_LONDON], platforms: [], enabled: false, updatedAt: new Date(THU) },
      [],
      THU,
    );
    expect(off.nextSlotAt).toBeNull();
  });
});

const DAY = 86_400_000;

describe('month-ahead drip queue (20.3)', () => {
  it('pins the limits: 28 weekly slots, a horizon that covers at least a month', () => {
    expect(MAX_DRIP_SLOTS).toBe(28);
    expect(DRIP_HORIZON_DAYS).toBeGreaterThanOrEqual(MONTH_AHEAD_DAYS);
    expect(MONTH_AHEAD_DAYS).toBeGreaterThanOrEqual(31);
    expect(DRIP_HORIZON_DAYS).toBe(56);
    expect(dripQueueInput.safeParse({ slots: Array(29).fill(MONDAY_0830_LONDON) }).success).toBe(
      false,
    );
  });

  it('a slot a month and a day away can still be taken', () => {
    const daily = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      time: '12:30',
      timezone: 'Europe/London',
    }));
    const held = upcomingSlots(daily, THU + 2 * 60_000)
      .filter((at) => at < THU + 32 * DAY)
      .map((at) => new Date(at));
    const next = firstFreeSlot(daily, held, THU) ?? 0;
    expect(next).toBeGreaterThan(THU + 32 * DAY);
  });

  it('resolves the upcoming window: default 31 days, capped at 62, to after from', () => {
    expect(upcomingWindow({}, THU)).toEqual({ fromMs: THU, toMs: THU + 31 * DAY });
    const from = '2026-10-01T00:00:00Z';
    expect(upcomingWindow({ from, to: '2026-12-02T00:00:00Z' }, THU)).toEqual({
      fromMs: Date.parse(from),
      toMs: Date.parse(from) + MAX_UPCOMING_RANGE_DAYS * DAY,
    });
    expect(() => upcomingWindow({ from, to: '2026-12-02T00:00:01Z' }, THU)).toThrow(
      ValidationError,
    );
    expect(() => upcomingWindow({ from, to: from }, THU)).toThrow(ValidationError);
    expect(upcomingQuery.safeParse({ from: 'yesterday' }).success).toBe(false);
    expect(upcomingQuery.safeParse({ from, extra: '1' }).success).toBe(false);
  });

  it('lists open slots in the window, skipping held, past and beyond-horizon ones', () => {
    const held = [new Date('2026-10-12T07:30:00Z')];
    const open = openSlotsBetween(
      [MONDAY_0830_LONDON],
      held,
      { fromMs: THU - 7 * DAY, toMs: THU + 31 * DAY },
      THU,
    ).map((t) => new Date(t).toISOString());
    expect(open).toEqual([
      '2026-10-05T07:30:00.000Z',
      '2026-10-19T07:30:00.000Z',
      '2026-10-26T08:30:00.000Z',
    ]);
    // A window starting exactly on a slot keeps that slot.
    const exact = Date.parse('2026-10-05T07:30:00Z');
    expect(
      openSlotsBetween([MONDAY_0830_LONDON], [], { fromMs: exact, toMs: exact + DAY }, THU),
    ).toEqual([exact]);
    // Beyond the horizon nothing is offered; a past window is empty.
    const far = THU + DRIP_HORIZON_DAYS * DAY + DAY;
    expect(
      openSlotsBetween([MONDAY_0830_LONDON], [], { fromMs: far, toMs: far + 30 * DAY }, THU),
    ).toEqual([]);
    expect(
      openSlotsBetween([MONDAY_0830_LONDON], [], { fromMs: THU - 30 * DAY, toMs: THU }, THU),
    ).toEqual([]);
  });

  it('explains why a scheduled project got no slot', () => {
    expect(unscheduledReason(null, ['tiktok'])).toBe('queue_off');
    expect(unscheduledReason({ enabled: false, platforms: [] }, ['tiktok'])).toBe('queue_off');
    expect(unscheduledReason({ enabled: true, platforms: ['youtube_short'] }, ['tiktok'])).toBe(
      'no_matching_platform',
    );
    expect(unscheduledReason({ enabled: true, platforms: [] }, ['tiktok'])).toBe('no_free_slot');
    expect(unscheduledReason({ enabled: true, platforms: ['tiktok'] }, ['tiktok'])).toBe(
      'no_free_slot',
    );
  });
});
