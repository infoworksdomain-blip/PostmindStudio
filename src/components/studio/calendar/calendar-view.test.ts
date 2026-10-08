import { describe, expect, it } from 'vitest';
import type { Publication } from '@/lib/client/types';
import {
  calendarSearch,
  dateFromKey,
  filterPublications,
  hasFilters,
  NO_FILTERS,
  parseCalendarParams,
  plannedMatches,
  platformsIn,
  shiftAnchor,
  sourceOf,
  viewDays,
  viewTitle,
  viewWindow,
  weekDays,
} from './calendar-view';
import { keyTarget } from './month-grid';
import type { PlannedPost } from './use-upcoming-slots';

// BACKLOG 25.9 — the calendar's URL state, view windows and client-side filters.

const pub = (id: string, over: Partial<Publication> = {}): Publication => ({
  id,
  projectId: `prj_${id}`,
  renderId: 'r',
  platform: 'tiktok',
  platformAccountId: 'acc',
  state: 'SCHEDULED',
  scheduledFor: '2026-10-14T10:00:00.000Z',
  publishedAt: null,
  platformPostId: null,
  platformUrl: null,
  caption: null,
  hashtags: [],
  errorReason: null,
  errorCode: null,
  retryCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

const planned = (over: Partial<PlannedPost> = {}): PlannedPost => ({
  slotAt: '2026-10-14T09:00:00.000Z',
  planId: 'plan',
  itemId: 'item',
  title: 'Topic',
  kind: 'VIDEO',
  status: 'GENERATING',
  ...over,
});

describe('URL state', () => {
  it('reads the defaults from an empty or malformed URL', () => {
    expect(parseCalendarParams(null)).toEqual({ view: 'month', date: null, filters: NO_FILTERS });
    expect(
      parseCalendarParams(
        new URLSearchParams('view=year&date=2026-02-30&platform=<x>&status=DONE&source=elsewhere'),
      ),
    ).toEqual({ view: 'month', date: null, filters: NO_FILTERS });
  });

  it('round-trips a view, day and filters, keeping other parameters', () => {
    const state = parseCalendarParams(
      new URLSearchParams('view=week&date=2026-10-14&platform=tiktok&status=FAILED&source=plan'),
    );
    expect(state).toEqual({
      view: 'week',
      date: '2026-10-14',
      filters: { platform: 'tiktok', status: 'FAILED', source: 'plan' },
    });
    const qs = calendarSearch(state, new URLSearchParams('business=b1'));
    expect(new URLSearchParams(qs).get('business')).toBe('b1');
    expect(parseCalendarParams(new URLSearchParams(qs))).toEqual(state);
    // The default view is left out of the URL.
    expect(calendarSearch({ ...state, view: 'month', date: null, filters: NO_FILTERS })).toBe('');
  });

  it('dateFromKey accepts real local days only', () => {
    expect(dateFromKey('2026-10-14')?.getDate()).toBe(14);
    expect(dateFromKey('2026-13-01')).toBeNull();
    expect(dateFromKey(null)).toBeNull();
  });
});

describe('views', () => {
  const wed = new Date(2026, 9, 14);

  it('a week runs Monday to Sunday around the anchor', () => {
    const days = weekDays(wed);
    expect(days.map((d) => d.getDate())).toEqual([12, 13, 14, 15, 16, 17, 18]);
    expect(weekDays(new Date(2026, 9, 18))[0]?.getDate()).toBe(12); // Sunday stays in its week
  });

  it('the window is local midnight to local midnight for each view', () => {
    expect(viewDays('month', wed)).toHaveLength(35);
    expect(viewDays('day', wed)).toHaveLength(1);
    const week = viewWindow('week', wed);
    expect(new Date(week.from).getTime()).toBe(new Date(2026, 9, 12).getTime());
    expect(new Date(week.to).getTime()).toBe(new Date(2026, 9, 19).getTime());
    const day = viewWindow('day', wed);
    expect(new Date(day.to).getTime() - new Date(day.from).getTime()).toBeGreaterThanOrEqual(
      23 * 3_600_000,
    );
  });

  it('previous / next move a month (keeping the day where it can), a week or a day', () => {
    expect(shiftAnchor('week', wed, 1).getDate()).toBe(21);
    expect(shiftAnchor('day', wed, -1).getDate()).toBe(13);
    const jan31 = new Date(2027, 0, 31);
    const feb = shiftAnchor('month', jan31, 1);
    expect([feb.getMonth(), feb.getDate()]).toEqual([1, 28]);
  });

  it('titles each view in the locale', () => {
    expect(viewTitle('month', wed, 'en-GB')).toBe('October 2026');
    expect(viewTitle('day', wed, 'en-GB')).toMatch(/^Wednesday,? 14 October 2026$/);
    expect(viewTitle('week', wed, 'en-GB')).toMatch(/12.+18 Oct 2026/);
  });

  it('keyboard moves on the month grid follow the reading direction', () => {
    expect(keyTarget(wed, 'ArrowRight', false)?.getDate()).toBe(15);
    expect(keyTarget(wed, 'ArrowRight', true)?.getDate()).toBe(13);
    expect(keyTarget(wed, 'ArrowDown', false)?.getDate()).toBe(21);
    expect(keyTarget(wed, 'Home', false)?.getDate()).toBe(12);
    expect(keyTarget(wed, 'End', false)?.getDate()).toBe(18);
    expect(keyTarget(wed, 'PageDown', false)?.getMonth()).toBe(10);
    expect(keyTarget(new Date(2026, 0, 31), 'PageDown', false)?.getDate()).toBe(28);
    expect(keyTarget(wed, 'a', false)).toBeNull();
  });
});

describe('filters', () => {
  const list = [
    pub('a'),
    pub('b', { platform: 'x', state: 'FAILED' }),
    pub('c', { campaign: { kind: 'plan', planId: 'p', startDate: '2026-10-01', days: 30 } }),
    pub('d', {
      campaign: { kind: 'automation', planId: 'p2', automationId: 'au', name: 'Weekly' },
    }),
  ];

  it('tells the source of a post', () => {
    expect(list.map(sourceOf)).toEqual(['manual', 'manual', 'plan', 'automation']);
  });

  it('filters by platform, state and source together', () => {
    expect(hasFilters(NO_FILTERS)).toBe(false);
    const ids = (f: Partial<typeof NO_FILTERS>) =>
      filterPublications(list, { ...NO_FILTERS, ...f }).map((p) => p.id);
    expect(ids({ platform: 'x' })).toEqual(['b']);
    expect(ids({ status: 'FAILED' })).toEqual(['b']);
    expect(ids({ source: 'automation' })).toEqual(['d']);
    expect(ids({ source: 'manual', platform: 'tiktok' })).toEqual(['a']);
    expect(ids({ status: 'PLANNED' })).toEqual([]);
  });

  it('month-plan posts in progress match their source and the "being made" status only', () => {
    expect(plannedMatches(planned(), NO_FILTERS)).toBe(true);
    expect(plannedMatches(planned(), { ...NO_FILTERS, platform: 'tiktok' })).toBe(false);
    expect(plannedMatches(planned(), { ...NO_FILTERS, status: 'SCHEDULED' })).toBe(false);
    expect(plannedMatches(planned(), { ...NO_FILTERS, status: 'PLANNED' })).toBe(true);
    expect(plannedMatches(planned(), { ...NO_FILTERS, source: 'plan' })).toBe(true);
    expect(plannedMatches(planned({ automationId: 'au' }), { ...NO_FILTERS, source: 'plan' })).toBe(
      false,
    );
    expect(plannedMatches(planned(), { ...NO_FILTERS, source: 'manual' })).toBe(false);
  });

  it('offers the platforms on screen plus the one selected', () => {
    expect(platformsIn(list, 'youtube')).toEqual(['tiktok', 'x', 'youtube']);
  });
});
