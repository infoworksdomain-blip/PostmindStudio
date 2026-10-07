import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import {
  createsAtOf,
  DEFAULT_LEAD_HOURS,
  expectedGenerationMs,
  immediateIds,
  isWaitingForWindow,
  rollingSettings,
  selectStarts,
} from './rolling';

// BACKLOG 23.6 — which month-plan posts the runner starts now (rolling generation).

const T0 = Date.parse('2026-10-06T08:00:00Z');
const HOUR = 3_600_000;
const settings = { leadMs: 72 * HOUR, immediateItems: 3 };

/** 3 posts a day (09:00, 13:00, 18:00 UTC) from tomorrow, `days` days. */
function month(days: number, kind: 'VIDEO' | 'CAROUSEL' | 'SLIDESHOW' = 'CAROUSEL') {
  return Array.from({ length: days * 3 }, (_, n) => {
    const day = Math.floor(n / 3) + 1;
    const hour = [9, 13, 18][n % 3]!;
    return {
      id: `i${n}`,
      position: n,
      slotAt: new Date(T0 + (day * 24 + hour - 8) * HOUR),
      status: 'QUEUED' as const,
      kind,
      format: null as string | null,
      startedAt: null as Date | null,
    };
  });
}

describe('rolling settings', () => {
  it('defaults to a 72 h window and 3 immediate posts; validates the env', () => {
    expect(rollingSettings({})).toEqual({ leadMs: DEFAULT_LEAD_HOURS * HOUR, immediateItems: 3 });
    expect(
      rollingSettings({ STUDIO_PLAN_LEAD_HOURS: '24', STUDIO_PLAN_IMMEDIATE_ITEMS: '0' }),
    ).toEqual({ leadMs: 24 * HOUR, immediateItems: 0 });
    expect(() => rollingSettings({ STUDIO_PLAN_LEAD_HOURS: '0' })).toThrow(ValidationError);
    expect(() => rollingSettings({ STUDIO_PLAN_IMMEDIATE_ITEMS: '1.5' })).toThrow(ValidationError);
  });

  it('knows a typical generation time per kind and automation format', () => {
    expect(expectedGenerationMs({ kind: 'CAROUSEL', format: null })).toBe(10 * 60_000);
    expect(expectedGenerationMs({ kind: 'VIDEO', format: 'ugc' })).toBe(60 * 60_000);
    expect(expectedGenerationMs({ kind: 'VIDEO', format: 'unknown' })).toBe(45 * 60_000);
  });
});

describe('selectStarts', () => {
  it('a full month starts only the first posts and the 72 h window; the rest wait', () => {
    const items = month(28);
    const plan = selectStarts(items, T0, settings);
    expect(plan.urgent).toEqual([]);
    // Window: slots up to T0 + 72 h = day 3 08:00 → days 1 and 2 (6 posts).
    expect(plan.ready.map((r) => r.item.id)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4', 'i5']);
    // The first 3 at normal priority (the owner sees them at once), the rest as batch work.
    expect(plan.ready.map((r) => r.priority)).toEqual([
      'normal',
      'normal',
      'normal',
      'batch',
      'batch',
      'batch',
    ]);
    expect(plan.waiting).toHaveLength(84 - 6);
  });

  it('the periodic tick picks posts up as they enter the window', () => {
    const items = month(28).map((i, n) =>
      n < 6 ? { ...i, status: 'SCHEDULED' as const, startedAt: new Date(T0) } : i,
    );
    const later = T0 + 26 * HOUR; // day 2 10:00: day 4 09:00 is now 71 h away
    const plan = selectStarts(items, later, settings);
    expect(plan.ready.map((r) => r.item.id)).toEqual(['i6', 'i7', 'i8', 'i9']);
    expect(plan.ready.every((r) => r.priority === 'batch')).toBe(true);
  });

  it('late-start safety: a post closer than twice its generation time is urgent', () => {
    const items = month(2, 'VIDEO');
    // Approved late: the first video posts in 60 min (< 2 × 45 min).
    const late = items[0]!.slotAt.getTime() - 60 * 60_000;
    const plan = selectStarts(items, late, settings);
    expect(plan.urgent.map((i) => i.id)).toEqual(['i0']);
    expect(plan.ready.map((r) => r.item.id)).not.toContain('i0');
  });

  it('immediate posts ignore removed and skipped ones', () => {
    const items = month(2).map((i, n) => (n === 0 ? { ...i, status: 'REMOVED' as const } : i));
    expect([...immediateIds(items, settings)]).toEqual(['i1', 'i2', 'i3']);
  });
});

describe('createsAt (calendar label)', () => {
  it('is the slot minus the window for a waiting post, null otherwise', () => {
    const items = month(28);
    const waiting = items[20]!;
    expect(createsAtOf(waiting, items, T0, settings)?.toISOString()).toBe(
      new Date(waiting.slotAt.getTime() - 72 * HOUR).toISOString(),
    );
    expect(isWaitingForWindow(waiting, items, T0, settings)).toBe(true);
    expect(createsAtOf(items[0]!, items, T0, settings)).toBeNull(); // immediate
    expect(createsAtOf(items[5]!, items, T0, settings)).toBeNull(); // in the window
    expect(createsAtOf({ ...waiting, status: 'GENERATING' }, items, T0, settings)).toBeNull();
  });
});
