import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as disputeRoute from '../../src/app/api/studio/businesses/[id]/domain-verification/dispute/route';
import * as domainRoute from '../../src/app/api/studio/businesses/[id]/domain-verification/route';
import * as scheduleRoute from '../../src/app/api/studio/businesses/[id]/scans/schedule/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { pollDomainVerifications } from '../../src/lib/studio/queue/workers/domain-verification';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import {
  sweepStockRefresh,
  sweepWebsiteRescans,
} from '../../src/lib/studio/queue/workers/scheduled-rescans';
import type { TenantContext } from '../../src/lib/tenant';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';

// BACKLOG 13.10 + 13.11 through the real routes, workers (inline queue) and Postgres:
// scan schedule, scheduled rescans with skip-if-unchanged, weekly stock refresh sweep,
// DNS TXT verification (Enterprise) and the disputed-ownership purge.

const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = 24 * 60 * 60 * 1000;
const bizOf = (job: { data: unknown }) => (job.data as { businessId?: string }).businessId;
const PLATFORM = { organisationId: 'postmind-platform', runId: 't', planTier: 'STANDARD' as const };

describe.skipIf(!hasDb)('scheduled rescans + domain verification', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-rescan-${randomUUID()}`;
  const enterprise: TenantContext = {
    ...tenant(org),
    organisation: { id: org, planTier: 'ENTERPRISE' },
  };
  const tokens = {
    owner: tenant(org),
    enterprise,
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(`api-rescan-other-${randomUUID()}`),
  };
  let h: ReturnType<typeof createHarness>;
  let api: ReturnType<typeof installApi>;
  let site: { status: number; etag?: string };

  const pageFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
    return new Response(site.status === 304 ? null : '<html></html>', {
      status: site.status,
      headers: site.etag ? { etag: site.etag } : {},
    });
  }) as typeof fetch;

  beforeEach(() => {
    site = { status: 304 };
    h = createHarness(db, { pageFetch });
    h.queue.defer.add('scan-website');
    h.queue.defer.add('refresh-image-library');
    api = installApi(db, tokens, {
      queue: h.queue,
      publishing: h.deps.publishing,
      pipeline: h.deps,
    });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.websiteScan.deleteMany({ where: { organisationId: org } });
    await db.domainVerification.deleteMany({ where: { organisationId: org } });
    await db.imageLibraryItem.deleteMany({ where: { organisationId: org } });
    await db.businessProfile.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  async function succeededScan(businessId: string, ageDays: number, etag: string | null) {
    const completedAt = new Date(Date.now() - ageDays * DAY);
    return db.websiteScan.create({
      data: {
        organisationId: org,
        businessId,
        url: `https://${businessId}.example/`,
        state: 'SUCCEEDED',
        startedAt: completedAt,
        completedAt,
        etag,
        planTier: 'PLUS',
      },
    });
  }

  const schedule = (businessId: string, token = 'owner') =>
    call(scheduleRoute.GET, { token, params: { id: businessId } });

  it('GET schedule: nothing before a scan; next scan 30 days after the last success', async () => {
    const biz = `biz-${randomUUID()}`;
    const empty = await schedule(biz);
    expect(empty.status).toBe(200);
    expect(empty.json).toMatchObject({ nextScanAt: null, nextStockRefreshAt: null });
    const scan = await succeededScan(biz, 2, '"v1"');
    await db.businessProfile.create({
      data: {
        organisationId: org,
        businessId: biz,
        industry: 'Food',
        subNiche: 'Bakery',
        imageSearchQueries: ['sourdough'],
        classifierModel: 'test',
      },
    });
    const res = await schedule(biz);
    const next = new Date(res.json.nextScanAt as string).getTime();
    expect(next).toBeGreaterThanOrEqual((scan.completedAt as Date).getTime() + 30 * DAY);
    expect(next).toBeLessThan((scan.completedAt as Date).getTime() + 31 * DAY);
    expect(res.json.nextStockRefreshAt).toEqual(expect.any(String));
    expect(res.json.lastSkippedUnchangedAt).toBeNull();
    expect((await schedule(biz, 'stranger')).json.nextScanAt).toBeNull();
  });

  it('a due rescan is skipped when the homepage answers 304, and scanned when it changed', async () => {
    const same = `biz-same-${randomUUID()}`;
    const changed = `biz-changed-${randomUUID()}`;
    const fresh = `biz-fresh-${randomUUID()}`;
    const sameScan = await succeededScan(same, 31, '"v1"');
    await succeededScan(fresh, 3, '"v1"');
    await sweepWebsiteRescans(PLATFORM, h.deps);
    const rescans = h.queue.pending.filter((j) => j.name === 'rescan-website');
    expect(rescans.some((j) => bizOf(j) === same)).toBe(true);
    expect(rescans.some((j) => bizOf(j) === fresh)).toBe(false);
    await drainInline(h.queue, h.deps);
    const after = await db.websiteScan.findUniqueOrThrow({ where: { id: sameScan.id } });
    expect(after.checkedUnchangedAt).not.toBeNull();
    expect(await db.websiteScan.count({ where: { organisationId: org, businessId: same } })).toBe(
      1,
    );
    expect((await schedule(same)).json.lastSkippedUnchangedAt).toEqual(expect.any(String));

    await succeededScan(changed, 40, '"v1"');
    site = { status: 200, etag: '"v2"' };
    await sweepWebsiteRescans(PLATFORM, h.deps);
    await drainInline(h.queue, h.deps);
    const scans = await db.websiteScan.findMany({
      where: { organisationId: org, businessId: changed },
      orderBy: { startedAt: 'desc' },
    });
    expect(scans).toHaveLength(2);
    expect(scans[0]).toMatchObject({ state: 'QUEUED', trigger: 'scheduled', planTier: 'PLUS' });
    expect(h.queue.deferred.some((j) => j.name === 'scan-website' && bizOf(j) === changed)).toBe(
      true,
    );
  });

  it('weekly stock refresh queues refresh-image-library for businesses with queries', async () => {
    const biz = `biz-stock-${randomUUID()}`;
    await db.businessProfile.create({
      data: {
        organisationId: org,
        businessId: biz,
        industry: 'Food',
        subNiche: 'Bakery',
        imageSearchQueries: ['bread'],
        classifierModel: 'test',
      },
    });
    await sweepStockRefresh(PLATFORM, h.deps);
    expect(
      h.queue.deferred.some((j) => j.name === 'refresh-image-library' && bizOf(j) === biz),
    ).toBe(true);
  });

  it('DNS verification: Enterprise only, TXT record issued, verified by the poll job', async () => {
    const biz = `biz-dns-${randomUUID()}`;
    const post = (
      token: string,
      body: unknown = { domain: 'https://www.Leeds-Sourdough.example/' },
    ) => call(domainRoute.POST, { method: 'POST', token, params: { id: biz }, body });
    expect((await post('owner')).status).toBe(403);
    expect((await post('reader')).status).toBe(403);
    expect((await post('enterprise', { domain: '10.0.0.1' })).status).toBe(400);
    const created = await post('enterprise');
    expect(created.status).toBe(201);
    const verification = created.json.verification as {
      id: string;
      record: string;
      value: string;
      state: string;
    };
    expect(verification.record).toBe('_postmind-studio.leeds-sourdough.example');
    expect(verification.value).toMatch(/^pm-studio-verify=[0-9a-f]{32}$/);
    expect(verification.state).toBe('PENDING');
    expect((await post('enterprise')).status).toBe(200); // same request, not a new token
    expect(api.audits.some((a) => a.action === 'studio.domain.verification_start')).toBe(true);

    h.deps.scan.resolveTxt = async (host) =>
      host === verification.record ? [[verification.value]] : [];
    await pollDomainVerifications(PLATFORM, h.deps);
    const got = await call(domainRoute.GET, { token: 'reader', params: { id: biz } });
    expect(got.status).toBe(200);
    expect(got.json.verification).toMatchObject({ state: 'VERIFIED', checkAttempts: 1 });
    expect((await call(domainRoute.GET, { token: 'stranger', params: { id: biz } })).status).toBe(
      404,
    );
  });

  it('a dispute purges the scraped images (not stock) and stops scheduled rescans', async () => {
    const biz = `biz-dispute-${randomUUID()}`;
    await succeededScan(biz, 45, '"v1"');
    for (const [source, key] of [
      ['SCRAPED', 'scraped.jpg'],
      ['STOCK', 'stock.jpg'],
    ] as const) {
      await h.deps.storage.put({
        bucket: 'assets',
        key: `${biz}/${key}`,
        body: new Uint8Array(4),
        contentType: 'image/jpeg',
      });
      await db.imageLibraryItem.create({
        data: {
          organisationId: org,
          businessId: biz,
          source,
          s3Bucket: 'assets',
          s3Key: `${biz}/${key}`,
          widthPx: 800,
          heightPx: 600,
          fileSizeBytes: 4,
          fingerprint: `${biz}-${key}`,
        },
      });
    }
    const dispute = (token: string, body: unknown) =>
      call(disputeRoute.POST, { method: 'POST', token, params: { id: biz }, body });
    expect((await dispute('reader', { reason: 'not mine', confirmNotOwner: true })).status).toBe(
      403,
    );
    expect((await dispute('owner', { reason: 'not mine' })).status).toBe(400);
    const res = await dispute('owner', { reason: 'Not our website', confirmNotOwner: true });
    expect(res.status).toBe(202);
    expect(res.json.verification).toMatchObject({ state: 'DISPUTED', domain: `${biz}.example` });
    expect((await dispute('owner', { reason: 'again!', confirmNotOwner: true })).status).toBe(409);
    await drainInline(h.queue, h.deps);
    const images = await db.imageLibraryItem.findMany({
      where: { organisationId: org, businessId: biz },
    });
    expect(images.map((i) => i.source)).toEqual(['STOCK']);
    expect(h.objects.has(`assets/${biz}/scraped.jpg`)).toBe(false);
    expect(h.objects.has(`assets/${biz}/stock.jpg`)).toBe(true);
    const row = await db.domainVerification.findFirstOrThrow({
      where: { organisationId: org, businessId: biz },
    });
    expect(row.state).toBe('PURGED');
    expect(row.purgeSummary).toMatchObject({ imagesDeleted: 1, objectsDeleted: 1 });
    expect(h.audits.some((a) => a.action === 'studio.domain.purge')).toBe(true);
    expect(api.audits.some((a) => a.action === 'studio.domain.dispute')).toBe(true);
    await sweepWebsiteRescans(PLATFORM, h.deps);
    expect(h.queue.pending.some((j) => j.name === 'rescan-website' && bizOf(j) === biz)).toBe(
      false,
    );
  });
});
