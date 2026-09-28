import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import * as profileRoute from '../../src/app/api/studio/businesses/[id]/business-profile/route';
import * as scanWebsiteRoute from '../../src/app/api/studio/businesses/[id]/scan-website/route';
import * as scanRoute from '../../src/app/api/studio/scans/[id]/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness, PROFILE_JSON } from '../helpers/pipeline-harness';

// BACKLOG 15.D8 — A11.2 "The checkbox text is preserved with the scan record for audit" and
// A13 "low-confidence classifications flagged for user review before use".

const hasDb = Boolean(process.env.DATABASE_URL);
const SITE = 'https://confidence-bakery.example';
const STATEMENT = 'I own this website or am authorised to represent it, including its images.';

const PAGE = `<!doctype html><html><head><title>Bakery</title></head><body><main><h1>Bakery</h1>
  <p>${'Bread and cakes baked daily. '.repeat(20)}</p></main></body></html>`;

const site = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n');
  if (url.pathname === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

describe.skipIf(!hasDb)(
  'scan ownership statement + classification review (15.D8)',
  {
    timeout: 120_000,
  },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const org = `api-scanreview-${randomUUID()}`;
    const tokens = { owner: tenant(org), reader: tenant(org, ['studio:project:read']) };

    afterAll(async () => {
      setApiDeps(undefined);
      await db.imageLibraryItem.deleteMany({ where: { organisationId: org } });
      await db.businessProfile.deleteMany({ where: { organisationId: org } });
      await db.websiteScan.deleteMany({ where: { organisationId: org } });
      await db.providerJob.deleteMany({ where: { organisationId: org } });
      await db.$disconnect();
    });

    function install(confidence: number) {
      const h = createHarness(db, { pageFetch: site, profile: { ...PROFILE_JSON, confidence } });
      const api = installApi(db, tokens, {
        queue: h.queue,
        publishing: h.deps.publishing,
        pipeline: h.deps,
      });
      return { h, api };
    }
    const scan = (biz: string, body: unknown) =>
      call(scanWebsiteRoute.POST, { method: 'POST', token: 'owner', params: { id: biz }, body });
    const profile = (biz: string) =>
      call(profileRoute.GET, { token: 'reader', params: { id: biz } });
    const patch = (biz: string, body: unknown) =>
      call(profileRoute.PATCH, { method: 'PATCH', token: 'owner', params: { id: biz }, body });

    it('requires the ownership statement and bounds it', async () => {
      install(0.9);
      const biz = `biz-${randomUUID()}`;
      const base = { url: SITE, ownershipConfirmed: true };
      expect((await scan(biz, base)).status).toBe(400);
      expect((await scan(biz, { ...base, ownershipStatement: 'yes' })).status).toBe(400);
      expect((await scan(biz, { ...base, ownershipStatement: 'x'.repeat(1_001) })).status).toBe(
        400,
      );
      expect(
        (await scan(biz, { url: SITE, ownershipConfirmed: false, ownershipStatement: STATEMENT }))
          .status,
      ).toBe(400);
    });

    it('stores the statement on the scan and in the audit entry; flags a low-confidence profile', async () => {
      const { h, api } = install(0.42);
      const biz = `biz-${randomUUID()}`;
      const started = await scan(biz, {
        url: SITE,
        ownershipConfirmed: true,
        ownershipStatement: `  ${STATEMENT}  `,
      });
      expect(started.status).toBe(202);
      const scanId = started.json.scanId as string;
      expect(
        (await db.websiteScan.findUniqueOrThrow({ where: { id: scanId } })).ownershipStatement,
      ).toBe(STATEMENT);
      const audit = api.audits.find((a) => a.action === 'studio.website_scan.start');
      expect(audit?.metadata).toMatchObject({ ownershipStatement: STATEMENT });
      const detail = await call(scanRoute.GET, { token: 'reader', params: { id: scanId } });
      expect((detail.json.scan as { ownershipStatement: string }).ownershipStatement).toBe(
        STATEMENT,
      );

      await drainInline(h.queue, h.deps);
      const flagged = (await profile(biz)).json.profile as Record<string, unknown>;
      expect(flagged).toMatchObject({ needsReview: true, classifierConfidence: 0.42 });

      // Confirming without edits clears the flag but is not an edit (re-scans may refresh it).
      const confirmed = await patch(biz, { confirmed: true });
      expect(confirmed.status).toBe(200);
      expect(confirmed.json.profile).toMatchObject({ needsReview: false, editedByUser: false });
      expect(
        api.audits.some(
          (a) =>
            a.action === 'studio.business_profile.update' &&
            (a.metadata?.fields as string[]).includes('confirmed'),
        ),
      ).toBe(true);
      expect((await patch(biz, { confirmed: false })).status).toBe(400);
    });

    it('a confident re-scan is not flagged; an edit clears a flag and marks the profile edited', async () => {
      const biz = `biz-${randomUUID()}`;
      let t = install(0.95);
      await scan(biz, { url: SITE, ownershipConfirmed: true, ownershipStatement: STATEMENT });
      await drainInline(t.h.queue, t.h.deps);
      expect((await profile(biz)).json.profile).toMatchObject({ needsReview: false });

      t = install(0.3);
      await scan(biz, { url: SITE, ownershipConfirmed: true, ownershipStatement: STATEMENT });
      await drainInline(t.h.queue, t.h.deps);
      expect((await profile(biz)).json.profile).toMatchObject({ needsReview: true });

      const edited = await patch(biz, { subNiche: 'Sourdough and cakes' });
      expect(edited.json.profile).toMatchObject({ needsReview: false, editedByUser: true });
    });
  },
);
