import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as defaultsRoute from '../../src/app/api/studio/content-plans/defaults/route';
import * as upcomingRoute from '../../src/app/api/studio/businesses/[id]/drip-queue/upcoming/route';
import * as dripRoute from '../../src/app/api/studio/businesses/[id]/drip-queue/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, tenant } from '../helpers/api-harness';

// 20.14 — the posting schedule through the real drip-queue routes on Postgres: daily and weekly
// schedules resolve to slots on the server (whatever slots the client sent), the schedule is
// stored and returned so the editor reopens in the same mode, invalid schedules and > 4 a day
// are 400s, pre-20.14 bodies (slots only) are stored as a custom schedule, and the month
// planner and the calendar read the resolved slots.

const hasDb = Boolean(process.env.DATABASE_URL);
const ZONE = 'Europe/London';

describe.skipIf(!hasDb)('20.14 posting schedule API', { timeout: 90_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-p20s-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
  };
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    api = installApi(db, tokens);
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.dripQueue.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  const newBiz = () => `biz-${randomUUID().slice(0, 8)}`;
  const put = (biz: string, body: unknown, token = 'owner') =>
    call(dripRoute.PUT, { method: 'PUT', token, params: { id: biz }, body });
  const get = (biz: string) => call(dripRoute.GET, { token: 'reader', params: { id: biz } });
  type Queue = {
    slots: Array<{ weekday: number; time: string; timezone: string }>;
    schedule: Record<string, unknown> | null;
  };
  const keys = (q: Queue) => q.slots.map((s) => `${s.weekday}@${s.time}`);

  it('a daily schedule resolves on the server and reopens in the same mode', async () => {
    const biz = newBiz();
    const schedule = {
      mode: 'daily',
      timezone: ZONE,
      postsPerDay: 4,
      timesMode: 'interval',
      intervalBy: 'user',
      intervalStart: '09:00',
      intervalMinutes: 180,
    };
    // The client's slots are ignored for a daily/weekly schedule.
    const res = await put(biz, {
      schedule,
      slots: [{ weekday: 2, time: '03:00', timezone: ZONE }],
    });
    expect(res.status).toBe(200);
    const q = res.json.dripQueue as Queue;
    expect(q.slots).toHaveLength(28);
    expect(keys(q).filter((k) => k.startsWith('1@'))).toEqual([
      '1@09:00',
      '1@12:00',
      '1@15:00',
      '1@18:00',
    ]);
    expect(keys(q)).not.toContain('2@03:00');
    const got = (await get(biz)).json.dripQueue as Queue;
    expect(got.schedule).toMatchObject({ ...schedule, days: [1, 2, 3, 4, 5, 6, 0] });
    expect(got.slots).toEqual(q.slots);
    const row = await db.dripQueue.findFirstOrThrow({
      where: { organisationId: org, businessId: biz },
    });
    expect(row.schedule).toMatchObject({ mode: 'daily', timesMode: 'interval' });
    const audit = api.audits.find((a) => a.action === 'studio.drip_queue.update');
    expect(audit?.metadata).toMatchObject({ slots: 28, mode: 'daily', timesMode: 'interval' });
  });

  it('a weekly schedule spreads N posts over the chosen days', async () => {
    const biz = newBiz();
    const res = await put(biz, {
      schedule: {
        mode: 'weekly',
        timezone: ZONE,
        postsPerWeek: 5,
        days: [1, 3, 5],
        timesMode: 'choose',
        times: ['10:00', '16:00'],
      },
    });
    expect(res.status).toBe(200);
    expect(keys(res.json.dripQueue as Queue)).toEqual([
      '1@10:00',
      '3@10:00',
      '3@16:00',
      '5@10:00',
      '5@16:00',
    ]);
    const upcoming = await call(upcomingRoute.GET, {
      token: 'reader',
      params: { id: biz },
      path: `/api/studio/businesses/${biz}/drip-queue/upcoming`,
    });
    expect(upcoming.json.upcoming).toMatchObject({ enabled: true, slotsPerWeek: 5 });
  });

  it('rejects invalid schedules and more than 4 posts on a day', async () => {
    const biz = newBiz();
    const cases: unknown[] = [
      // 13 posts on 3 days is more than 4 a day.
      { schedule: { mode: 'weekly', timezone: ZONE, postsPerWeek: 13, days: [1, 3, 5] } },
      // Times out of order / too close.
      {
        schedule: {
          mode: 'daily',
          timezone: ZONE,
          postsPerDay: 2,
          timesMode: 'choose',
          times: ['09:00', '09:10'],
        },
      },
      // Interval past midnight.
      {
        schedule: {
          mode: 'daily',
          timezone: ZONE,
          postsPerDay: 4,
          timesMode: 'interval',
          intervalStart: '18:00',
          intervalMinutes: 240,
        },
      },
      { schedule: { mode: 'daily', timezone: ZONE, postsPerDay: 5 } },
      { schedule: { mode: 'daily', timezone: 'Mars/Olympus' } },
      // A custom schedule needs slots, at most 4 on a weekday.
      { schedule: { mode: 'custom', timezone: ZONE } },
      {
        slots: ['08:00', '10:00', '12:00', '14:00', '16:00'].map((time) => ({
          weekday: 1,
          time,
          timezone: ZONE,
        })),
      },
      {},
    ];
    for (const body of cases) {
      const res = await put(biz, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const tooMany = await put(biz, cases[0]);
    expect(JSON.stringify(tooMany.json)).toMatch(/At most 4 posts a day/);
    expect((await put(biz, cases[0], 'reader')).status).toBe(403);
    expect((await get(biz)).json.dripQueue).toBeNull();
  });

  it('pre-20.14 bodies (slots only) are kept as a custom schedule', async () => {
    const biz = newBiz();
    const slots = [
      { weekday: 1, time: '12:30', timezone: ZONE },
      { weekday: 6, time: '09:00', timezone: ZONE },
    ];
    const res = await put(biz, { slots });
    expect(res.status).toBe(200);
    const q = res.json.dripQueue as Queue;
    expect(q.slots).toEqual(slots);
    expect(q.schedule).toMatchObject({ mode: 'custom', timezone: ZONE });
  });

  it('a queue saved before 20.14 (schedule NULL) still reads, with schedule null', async () => {
    const biz = newBiz();
    await db.dripQueue.create({
      data: {
        organisationId: org,
        businessId: biz,
        slots: [{ weekday: 3, time: '12:30', timezone: ZONE }],
        platforms: [],
        updatedByUserId: 'user-1',
      },
    });
    const q = (await get(biz)).json.dripQueue as Queue;
    expect(q.schedule).toBeNull();
    expect(keys(q)).toEqual(['3@12:30']);
  });

  it('the month planner reads a daily schedule’s resolved slots', async () => {
    const biz = newBiz();
    await put(biz, { schedule: { mode: 'daily', timezone: ZONE, postsPerDay: 3 } });
    const res = await call(defaultsRoute.GET, {
      token: 'reader',
      path: `/api/studio/content-plans/defaults?businessId=${biz}`,
    });
    expect(res.status).toBe(200);
    expect(res.json.defaults).toMatchObject({
      postsPerDay: 3,
      hasPostingTimes: true,
      postingTimesPerWeek: 21,
      timezone: ZONE,
    });
  });
});
