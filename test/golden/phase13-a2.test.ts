import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import * as disputeRoute from '../../src/app/api/studio/businesses/[id]/domain-verification/dispute/route';
import * as scheduleRoute from '../../src/app/api/studio/businesses/[id]/scans/schedule/route';
import * as scanWebsiteRoute from '../../src/app/api/studio/businesses/[id]/scan-website/route';
import * as publicationRoute from '../../src/app/api/studio/publications/[id]/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { sweepWebsiteRescans } from '../../src/lib/studio/queue/workers/scheduled-rescans';
import { call } from '../helpers/api-harness';
import {
  approvedTikTokProject,
  BUSINESS_ID,
  cleanupGolden,
  connect,
  drain,
  getPublication,
  ORG_PREFIX,
  publish,
  startJourney,
} from './journey-kit';
import { goldenWebsite } from './website-fixture';

// Phase 13 track A2 journeys, end to end through the real routes, workers (inline queue) and
// Postgres:
//   A2-01  scan → 30 days on: homepage unchanged (304) → rescan skipped → site changes →
//          scheduled rescan runs → owner disputes the site → scraped images purged, stock kept
//   A2-02  schedule a post → drag it to another time → the old delayed job is a no-op → the
//          post goes out from the new job

const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = 24 * 60 * 60 * 1000;
const PLATFORM = {
  organisationId: 'postmind-platform',
  runId: 'golden',
  planTier: 'STANDARD' as const,
};

describe.skipIf(!hasDb)('golden journeys: Phase 13 A2', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  afterAll(async () => {
    setApiDeps(undefined);
    await db.domainVerification.deleteMany({
      where: { organisationId: { startsWith: ORG_PREFIX } },
    });
    await cleanupGolden(db, since);
    await db.$disconnect();
  }, 120_000);

  it('A2-01 rescan skipped while unchanged, run when changed, purged on dispute', async () => {
    const { site, pageFetch: base, stock } = goldenWebsite();
    let etag = '"v1"';
    const homepageRequests: Array<string | null> = [];
    const pageFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname !== new URL(site).hostname || url.pathname !== '/') return base(input, init);
      const ifNoneMatch = new Headers(init?.headers).get('if-none-match');
      homepageRequests.push(ifNoneMatch);
      if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: { etag } });
      const page = await base(input, init);
      return new Response(await page.text(), {
        headers: { 'content-type': 'text/html', etag },
      });
    }) as typeof fetch;
    const j = startJourney(db, 'a2-01', { pageFetch, stockSources: [stock] });

    // First scan, started by the owner.
    const started = await call(scanWebsiteRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: BUSINESS_ID },
      body: { url: site, ownershipConfirmed: true },
    });
    expect(started.status).toBe(202);
    await drain(j);
    const first = await db.websiteScan.findFirstOrThrow({
      where: { organisationId: j.org, businessId: BUSINESS_ID },
    });
    expect(first).toMatchObject({ state: 'SUCCEEDED', etag: '"v1"', trigger: 'manual' });
    const schedule = await call(scheduleRoute.GET, {
      token: 'reader',
      params: { id: BUSINESS_ID },
    });
    expect(schedule.json.nextScanAt).toEqual(expect.any(String));

    // 31 days later the homepage has not changed: the sweep's conditional request gets a 304.
    await db.websiteScan.update({
      where: { id: first.id },
      data: {
        completedAt: new Date(Date.now() - 31 * DAY),
        startedAt: new Date(Date.now() - 31 * DAY),
      },
    });
    await sweepWebsiteRescans(PLATFORM, j.h.deps);
    await drain(j);
    expect(homepageRequests.at(-1)).toBe('"v1"');
    expect(await db.websiteScan.count({ where: { organisationId: j.org } })).toBe(1);
    expect(
      (await call(scheduleRoute.GET, { token: 'reader', params: { id: BUSINESS_ID } })).json
        .lastSkippedUnchangedAt,
    ).toEqual(expect.any(String));

    // Another 31 days on, the site has changed: the scheduled rescan runs the full scan.
    etag = '"v2"';
    await db.websiteScan.update({
      where: { id: first.id },
      data: { checkedUnchangedAt: new Date(Date.now() - 31 * DAY) },
    });
    // (a later day's sweep: one rescan job per scan per day)
    await sweepWebsiteRescans(PLATFORM, { ...j.h.deps, now: () => Date.now() + 2 * DAY });
    await drain(j);
    const scans = await db.websiteScan.findMany({
      where: { organisationId: j.org },
      orderBy: { startedAt: 'desc' },
    });
    expect(scans).toHaveLength(2);
    expect(scans[0]).toMatchObject({ state: 'SUCCEEDED', trigger: 'scheduled', etag: '"v2"' });

    // The owner reports they do not own the site: scraped images go, stock stays.
    const before = await db.imageLibraryItem.groupBy({
      by: ['source'],
      where: { organisationId: j.org, businessId: BUSINESS_ID },
      _count: { _all: true },
    });
    expect(before.find((g) => g.source === 'SCRAPED')?._count._all).toBeGreaterThan(0);
    const disputed = await call(disputeRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: BUSINESS_ID },
      body: { reason: 'We scanned the wrong website', confirmNotOwner: true },
    });
    expect(disputed.status).toBe(202);
    await drain(j);
    const after = await db.imageLibraryItem.groupBy({
      by: ['source'],
      where: { organisationId: j.org, businessId: BUSINESS_ID },
      _count: { _all: true },
    });
    expect(after.find((g) => g.source === 'SCRAPED')).toBeUndefined();
    expect(after.find((g) => g.source === 'STOCK')?._count._all).toBeGreaterThan(0);
    expect(
      (await db.domainVerification.findFirstOrThrow({ where: { organisationId: j.org } })).state,
    ).toBe('PURGED');
  });

  it('A2-02 a rescheduled post goes out from the new job only', async () => {
    const j = startJourney(db, 'a2-02');
    j.h.queue.defer.add('fire-scheduled-publication');
    const { render } = await approvedTikTokProject(j);
    const conn = await connect(j, 'tiktok');
    const pubId = await publish(j, {
      renderId: render.id,
      platform: 'tiktok',
      connectionId: conn.id,
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const original = j.h.queue.deferred.find((job) => job.name === 'fire-scheduled-publication');
    const moved = await call(publicationRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: pubId },
      body: { scheduledFor: new Date(Date.now() + 26 * 3_600_000).toISOString() },
    });
    expect(moved.status).toBe(200);
    // The old job still fires (as if BullMQ had not removed it): nothing is posted.
    if (original) j.h.queue.pending.push(original);
    await drain(j);
    expect((await getPublication(j, pubId)).state).toBe('SCHEDULED');
    expect(j.h.publishers.tiktok.published).toHaveLength(0);
    // The new time arrives.
    expect(j.h.queue.release('fire-scheduled-publication')).toBe(1);
    await drain(j);
    expect((await getPublication(j, pubId)).state).toBe('PUBLISHED');
    expect(j.h.publishers.tiktok.published).toHaveLength(1);
  });
});
