import { describe, expect, it } from 'vitest';
import {
  buildPlanBody,
  canChangeScheduled,
  createsLaterCount,
  dayOf,
  groupByDay,
  kindCounts,
  liveItems,
  moveItem,
  pointsFromText,
  requestedPosts,
  validatePlanForm,
  waitingToCreate,
  writtenCount,
  type PlanFormState,
  type PlanItem,
} from './plan-model';

const item = (id: string, slotAt: string, patch: Partial<PlanItem> = {}): PlanItem => ({
  id,
  position: 0,
  slotAt,
  kind: 'VIDEO',
  angle: 'how_to',
  title: id,
  brief: '',
  slides: null,
  calendarDay: null,
  status: 'PLANNED',
  statusReason: null,
  projectId: null,
  ...patch,
});

const FORM: PlanFormState = {
  startDate: '2026-10-01',
  days: 30,
  postsPerDay: 2,
  useDripSlots: false,
  videoShare: 40,
  platforms: ['tiktok'],
  accounts: { tiktok: 'conn_1' },
};

describe('20.9 plan model', () => {
  it('groups by local day in the plan’s time zone', () => {
    // 23:30 UTC on 30 Sep is 00:30 on 1 Oct in London (BST).
    const items = [item('b', '2026-10-01T08:00:00.000Z'), item('a', '2026-09-30T23:30:00.000Z')];
    expect(dayOf(items[1]!.slotAt, 'Europe/London')).toBe('2026-10-01');
    expect(groupByDay(items, 'Europe/London')).toEqual([
      { day: '2026-10-01', items: [items[1], items[0]] },
    ]);
  });

  it('counts kinds, written topics and live items', () => {
    const items = [
      item('a', '2026-10-01T08:00:00Z'),
      item('b', '2026-10-01T09:00:00Z', { kind: 'SLIDESHOW', title: '' }),
      item('c', '2026-10-01T10:00:00Z', { status: 'REMOVED' }),
    ];
    expect(kindCounts(items)).toEqual({ VIDEO: 2, SLIDESHOW: 1, CAROUSEL: 0 });
    expect(writtenCount(items)).toBe(2);
    expect(liveItems(items).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('lets the owner change open posts only before their time', () => {
    const now = Date.parse('2026-10-01T09:00:00Z');
    const later = '2026-10-02T09:00:00Z';
    expect(canChangeScheduled(item('a', later, { status: 'SCHEDULED' }), now)).toBe(true);
    expect(canChangeScheduled(item('a', later, { status: 'POSTED' }), now)).toBe(false);
    expect(
      canChangeScheduled(item('a', '2026-10-01T08:00:00Z', { status: 'SCHEDULED' }), now),
    ).toBe(false);
  });

  it('23.6: a queued post with a future creation time is waiting, not being made', () => {
    const now = Date.parse('2026-10-01T09:00:00Z');
    const slot = '2026-10-09T09:00:00Z';
    const waiting = item('a', slot, { status: 'QUEUED', createsAt: '2026-10-06T09:00:00Z' });
    const due = item('b', slot, { status: 'QUEUED', createsAt: '2026-10-01T08:00:00Z' });
    const unknown = item('c', slot, { status: 'QUEUED', createsAt: null });
    const legacy = item('d', slot, { status: 'QUEUED' });
    const making = item('e', slot, { status: 'GENERATING', createsAt: '2026-10-06T09:00:00Z' });
    const bad = item('f', slot, { status: 'QUEUED', createsAt: 'not a date' });
    expect(waitingToCreate(waiting, now)).toBe(true);
    for (const other of [due, unknown, legacy, making, bad])
      expect(waitingToCreate(other, now)).toBe(false);
    expect(createsLaterCount([waiting, due, unknown, legacy, making, bad, waiting], now)).toBe(2);
    expect(createsLaterCount([], now)).toBe(0);
  });

  it('moves topics and parses slide points', () => {
    expect(moveItem(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(pointsFromText(' one \n\n two\nthree\nfour\nfive\nsix')).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
    ]);
    expect(requestedPosts(30, 4)).toBe(120);
  });

  it('validates the form and builds the POST body', () => {
    expect(validatePlanForm(FORM)).toEqual([]);
    expect(validatePlanForm({ ...FORM, days: 40 })).toEqual(['daysRange']);
    expect(validatePlanForm({ ...FORM, platforms: [] })).toEqual(['platformRequired']);
    expect(validatePlanForm({ ...FORM, accounts: {} })).toEqual(['accountRequired']);
    expect(validatePlanForm({ ...FORM, startDate: '' })).toEqual(['startRequired']);
    expect(buildPlanBody(FORM, 'biz_1', 'Europe/London')).toEqual({
      businessId: 'biz_1',
      startDate: '2026-10-01',
      days: 30,
      postsPerDay: 2,
      videoShare: 40,
      platforms: ['tiktok'],
      targets: [{ platform: 'tiktok', connectionId: 'conn_1' }],
      timezone: 'Europe/London',
    });
    expect(buildPlanBody({ ...FORM, useDripSlots: true }, 'biz_1', 'UTC')).toMatchObject({
      useDripSlots: true,
    });
  });

  it('20.12: platforms without a connected account never block the plan', () => {
    const two = { ...FORM, platforms: ['tiktok', 'x'], accounts: { tiktok: 'conn_1' } };
    // X has no account: made but not posted. No account at all: saved for review.
    expect(validatePlanForm(two, 31, ['tiktok'])).toEqual([]);
    expect(validatePlanForm({ ...two, accounts: {} }, 31, [])).toEqual([]);
    expect(validatePlanForm({ ...two, accounts: {} }, 31, ['tiktok'])).toEqual(['accountRequired']);
    expect(buildPlanBody(two, 'biz_1', 'UTC').targets).toEqual([
      { platform: 'tiktok', connectionId: 'conn_1' },
    ]);
    expect(buildPlanBody({ ...two, accounts: {} }, 'biz_1', 'UTC').targets).toEqual([]);
  });
});
