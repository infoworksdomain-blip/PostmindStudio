import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STAGGER_MINUTES,
  dripQueueInput,
  firstFreeSlot,
  parseSlots,
  publicDripQueue,
  staggerMinutes,
  upcomingSlots,
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
