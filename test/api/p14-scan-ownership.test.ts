import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as scanWebsiteRoute from '../../src/app/api/studio/businesses/[id]/scan-website/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { HeadlessRenderer } from '../../src/lib/studio/scan/headless-render';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { rescanWebsite } from '../../src/lib/studio/queue/workers/scheduled-rescans';
import { headlessFor } from '../../src/lib/studio/queue/workers/scan-website';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';

// BACKLOG 14.4 — the browser-render fallback for a homepage refused by bot protection is used
// ONLY when the business owner confirmed ownership, and that confirmation is stored per scan
// (who and when). A scan without a stored confirmation (made before 14.4) never uses it.

const hasDb = Boolean(process.env.DATABASE_URL);
const SITE = 'https://blocked-bakery.example';
const RENDERED = `<!doctype html><html><head><title>Blocked Bakery</title></head><body><main>
  <h1>Blocked Bakery</h1><p>${'Sourdough baked daily in Leeds. '.repeat(12)}</p></main></body></html>`;

/** A site whose homepage answers 403 (bot protection) but allows robots. */
const blockedSite = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n');
  if (url.pathname === '/') return new Response('Access denied', { status: 403 });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

describe('headlessFor', () => {
  const headless: HeadlessRenderer = { configured: true, render: async () => '' };
  it('passes the renderer only for a scan with a stored ownership confirmation', () => {
    expect(headlessFor({ ownershipConfirmedAt: new Date() }, headless)).toBe(headless);
    expect(headlessFor({ ownershipConfirmedAt: null }, headless)).toBeUndefined();
  });
});

describe.skipIf(!hasDb)(
  'scan ownership confirmation gates the render fallback',
  { timeout: 120_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const org = `api-p14-own-${randomUUID()}`;
    let h: ReturnType<typeof createHarness>;
    let render: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      h = createHarness(db, { pageFetch: blockedSite, stockSources: [] });
      render = vi.fn(async () => RENDERED);
      h.deps.scan.headless = { configured: true, render: render as HeadlessRenderer['render'] };
      installApi(
        db,
        { owner: tenant(org, undefined, 'owner-user') },
        {
          queue: h.queue,
          publishing: h.deps.publishing,
          pipeline: h.deps,
        },
      );
    });

    afterAll(async () => {
      setApiDeps(undefined);
      await db.imageLibraryItem.deleteMany({ where: { organisationId: org } });
      await db.businessProfile.deleteMany({ where: { organisationId: org } });
      await db.websiteScan.deleteMany({ where: { organisationId: org } });
      await db.providerJob.deleteMany({ where: { organisationId: org } });
      await db.$disconnect();
    });

    it('stores who confirmed ownership and when, and renders the blocked homepage', async () => {
      const biz = `biz-${randomUUID()}`;
      const res = await call(scanWebsiteRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id: biz },
        // 15.D8: the exact checkbox text is sent and stored with the confirmation.
        body: {
          url: SITE,
          ownershipConfirmed: true,
          ownershipStatement: 'I own or am authorised to represent this website.',
        },
      });
      expect(res.status).toBe(202);
      await drainInline(h.queue, h.deps);
      const scan = await db.websiteScan.findUniqueOrThrow({
        where: { id: res.json.scanId as string },
      });
      expect(scan.ownershipConfirmedByUserId).toBe('owner-user');
      expect(scan.ownershipConfirmedAt).toBeInstanceOf(Date);
      expect(render).toHaveBeenCalledWith(`${SITE}/`);
      expect(scan).toMatchObject({ state: 'SUCCEEDED', usedJsRender: true });
    });

    it('a scheduled rescan carries the confirmation of the scan it repeats', async () => {
      const biz = `biz-${randomUUID()}`;
      const confirmedAt = new Date('2026-08-01T10:00:00Z');
      const done = await db.websiteScan.create({
        data: {
          organisationId: org,
          businessId: biz,
          url: `${SITE}/`,
          state: 'SUCCEEDED',
          completedAt: new Date(),
          ownershipConfirmedAt: confirmedAt,
          ownershipConfirmedByUserId: 'owner-user',
        },
      });
      await rescanWebsite(
        {
          scanId: done.id,
          organisationId: org,
          businessId: biz,
          runId: done.id,
          planTier: 'STANDARD',
        },
        h.deps,
      );
      const rescan = await db.websiteScan.findFirstOrThrow({
        where: { organisationId: org, businessId: biz, trigger: 'scheduled' },
      });
      expect(rescan.ownershipConfirmedAt?.toISOString()).toBe(confirmedAt.toISOString());
      expect(rescan.ownershipConfirmedByUserId).toBe('owner-user');
    });

    it('never renders for a scan without a stored confirmation', async () => {
      const biz = `biz-${randomUUID()}`;
      const legacy = await db.websiteScan.create({
        data: { organisationId: org, businessId: biz, url: `${SITE}/`, state: 'QUEUED' },
      });
      await h.queue.add('scan-website', {
        scanId: legacy.id,
        organisationId: org,
        businessId: biz,
        runId: legacy.id,
        planTier: 'STANDARD',
      });
      await drainInline(h.queue, h.deps);
      expect(render).not.toHaveBeenCalled();
      const scan = await db.websiteScan.findUniqueOrThrow({ where: { id: legacy.id } });
      expect(scan.state).toBe('FAILED');
      expect(scan.usedJsRender).toBe(false);
    });
  },
);
