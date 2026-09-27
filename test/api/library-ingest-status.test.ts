import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as adminIngestRoute from '../../src/app/api/studio/admin/library/ingest/route';
import * as statusRoute from '../../src/app/api/studio/admin/library/ingest/status/route';
import * as adminVideoRoute from '../../src/app/api/studio/admin/library/videos/[id]/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { NOT_REQUIRED_DEFAULT_SOURCE } from '../../src/lib/studio/library/ingest';
import { parseCorpusBuckets } from '../../src/lib/studio/library/corpus-source';
import { seedTaxonomy } from '../../src/lib/studio/library/taxonomy';
import { ingestRunId } from '../../src/lib/studio/services/library';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';

// Corpus ingestion (BACKLOG 9.2/9.3 tooling): NOT_REQUIRED licence through the admin API, run
// tracking, GET /admin/library/ingest/status, resubmission (skip / retry) and s3:// sources from
// an allow-listed bucket — real routes, worker and Postgres.

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);
const PREFIX = `https://corpus-status.example/${RUN}/`;
const OK_URL = `${PREFIX}ok.mp4`;
const MISSING_URL = `${PREFIX}missing.mp4`;
const S3_URL = `s3://postmind-corpus/${RUN}/owned.mp4`;

describe.skipIf(!hasDb)(
  'corpus ingestion status + NOT_REQUIRED licence',
  { timeout: 120_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const org = `api-corpus-${randomUUID()}`;
    let missingIsMissing = true;
    const pageFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === MISSING_URL && missingIsMissing) return new Response('gone', { status: 404 });
      return new Response(new TextEncoder().encode(`corpus bytes ${url}`), {
        headers: { 'content-type': 'video/mp4' },
      });
    }) as typeof fetch;
    let h: ReturnType<typeof createHarness>;

    beforeAll(async () => {
      await seedTaxonomy(
        db,
        JSON.parse(
          readFileSync(join(__dirname, '../../prisma/data/library-taxonomy.json'), 'utf8'),
        ),
      );
      h = createHarness(db, { pageFetch });
      h.deps.config = { ...h.deps.config, corpusS3Buckets: parseCorpusBuckets('postmind-corpus') };
      await h.deps.storage.put({
        bucket: 'postmind-corpus',
        key: `${RUN}/owned.mp4`,
        body: new TextEncoder().encode(`s3 corpus bytes ${RUN}`),
        contentType: 'video/mp4',
      });
      installApi(
        db,
        {
          staff: tenant(org, ['studio:project:read', 'studio:admin:library']),
          reader: tenant(org, ['studio:project:read']),
        },
        { queue: h.queue, publishing: h.deps.publishing, pipeline: h.deps },
      );
    }, 120_000);

    afterAll(async () => {
      setApiDeps(undefined);
      const runIds = [OK_URL, MISSING_URL, S3_URL].map(ingestRunId);
      const runs = await db.videoLibraryIngestRun.findMany({ where: { runId: { in: runIds } } });
      const itemIds = runs.flatMap((r) => (r.libraryItemId ? [r.libraryItemId] : []));
      await db.$executeRaw`DELETE FROM studio.video_library_embeddings WHERE "libraryItemId" = ANY(${itemIds})`;
      await db.videoLibraryAnalysis.deleteMany({ where: { libraryItemId: { in: itemIds } } });
      await db.videoLibraryLicense.deleteMany({ where: { libraryItemId: { in: itemIds } } });
      await db.videoLibraryItem.deleteMany({ where: { id: { in: itemIds } } });
      await db.videoLibraryIngestRun.deleteMany({ where: { runId: { in: runIds } } });
      await db.$disconnect();
    }, 120_000);

    const ingest = (items: unknown[]) =>
      call(adminIngestRoute.POST, { method: 'POST', token: 'staff', body: { items } });
    const status = (query: string, token = 'staff') =>
      call(statusRoute.GET, { token, path: `/api/studio/admin/library/ingest/status?${query}` });

    it('ingests NOT_REQUIRED items (https and allow-listed s3) with both modes and an audit trail', async () => {
      const res = await ingest([
        {
          sourceUrl: OK_URL,
          licenseScenario: 'NOT_REQUIRED',
          sourceRef: 'ext-ok',
          language: 'en',
          tags: [],
        },
        { sourceUrl: MISSING_URL, licenseScenario: 'NOT_REQUIRED', tags: [] },
        {
          sourceUrl: S3_URL,
          licenseScenario: 'NOT_REQUIRED',
          licenseSource: 'Operator decision 2026-09-27 (ops ticket 7)',
          tags: [],
        },
      ]);
      expect(res.status).toBe(202);
      const queued = res.json.queued as Array<{ runId: string; jobId: string }>;
      expect(queued.map((q) => q.runId)).toEqual([OK_URL, MISSING_URL, S3_URL].map(ingestRunId));
      const before = await status(`runIds=${queued.map((q) => q.runId).join(',')}`);
      expect((before.json.runs as Array<{ state: string }>).map((r) => r.state)).toEqual([
        'QUEUED',
        'QUEUED',
        'QUEUED',
      ]);

      const drained = await drainInline(h.queue, h.deps);
      expect(drained.failedJobs).toHaveLength(1); // the 404 source

      const ok = await db.videoLibraryItem.findFirstOrThrow({
        where: { sourceUrl: OK_URL },
        include: { license: true },
      });
      expect(ok.license).toMatchObject({
        scenario: 'NOT_REQUIRED',
        allowedModes: ['TEMPLATE', 'INSPIRE'],
        licenseSource: NOT_REQUIRED_DEFAULT_SOURCE,
      });
      const s3 = await db.videoLibraryItem.findFirstOrThrow({
        where: { sourceUrl: S3_URL },
        include: { license: true },
      });
      expect(s3.license?.licenseSource).toBe('Operator decision 2026-09-27 (ops ticket 7)');
      expect(s3.license?.allowedModes).toEqual(['TEMPLATE', 'INSPIRE']);
    });

    it('reports counts by state, recent failures with reasons, and per-run state', async () => {
      expect((await status('windowHours=1', 'reader')).status).toBe(403);
      expect((await status('windowHours=0')).status).toBe(400);
      expect((await status('runIds=not-hex!')).status).toBe(400);

      const res = await status('windowHours=1&failures=50');
      expect(res.status).toBe(200);
      const counts = res.json.counts as Record<string, number>;
      expect(counts.SUCCEEDED).toBeGreaterThanOrEqual(2);
      expect(counts.FAILED).toBeGreaterThanOrEqual(1);
      expect(res.json.windowHours).toBe(1);
      expect(res.json.liveLibraryItems as number).toBeGreaterThanOrEqual(2);
      const failures = res.json.recentFailures as Array<Record<string, unknown>>;
      expect(failures.find((f) => f.sourceUrl === MISSING_URL)).toMatchObject({
        runId: ingestRunId(MISSING_URL),
        errorReason: expect.stringContaining('HTTP 404'),
        attempts: 1,
      });

      const runs = await status(`runIds=${ingestRunId(OK_URL)},${ingestRunId(MISSING_URL)}`);
      const byRun = new Map(
        (runs.json.runs as Array<{ runId: string; state: string; sourceRef: string | null }>).map(
          (r) => [r.runId, r],
        ),
      );
      expect(byRun.get(ingestRunId(OK_URL))).toMatchObject({
        state: 'SUCCEEDED',
        sourceRef: 'ext-ok',
      });
      expect(byRun.get(ingestRunId(MISSING_URL))?.state).toBe('FAILED');
    });

    it('skips sources already ingested and re-enqueues failed ones under a fresh job id', async () => {
      missingIsMissing = false;
      const res = await ingest([
        { sourceUrl: OK_URL, licenseScenario: 'NOT_REQUIRED', tags: [] },
        { sourceUrl: MISSING_URL, licenseScenario: 'NOT_REQUIRED', tags: [] },
      ]);
      expect(res.status).toBe(202);
      expect(res.json.skipped).toEqual([
        expect.objectContaining({ sourceUrl: OK_URL, state: 'SUCCEEDED' }),
      ]);
      expect(res.json.queued).toEqual([
        expect.objectContaining({
          sourceUrl: MISSING_URL,
          jobId: `ingest-library-video__${ingestRunId(MISSING_URL)}__retry1`,
        }),
      ]);
      const drained = await drainInline(h.queue, h.deps);
      expect(drained.failedJobs).toEqual([]);
      const run = await db.videoLibraryIngestRun.findUniqueOrThrow({
        where: { runId: ingestRunId(MISSING_URL) },
      });
      expect(run).toMatchObject({ state: 'SUCCEEDED', attempts: 2, errorReason: null });
    });

    it('refuses s3 sources outside the allow-list and unsupported schemes', async () => {
      expect(
        (
          await ingest([
            { sourceUrl: 'file:///etc/passwd', licenseScenario: 'NOT_REQUIRED', tags: [] },
          ])
        ).status,
      ).toBe(400);
      const other = `s3://someone-elses-bucket/${RUN}/x.mp4`;
      const res = await ingest([{ sourceUrl: other, licenseScenario: 'NOT_REQUIRED', tags: [] }]);
      expect(res.status).toBe(202);
      await drainInline(h.queue, h.deps);
      const run = await db.videoLibraryIngestRun.findUniqueOrThrow({
        where: { runId: ingestRunId(other) },
      });
      expect(run.state).toBe('FAILED');
      expect(run.errorReason).toContain('STUDIO_CORPUS_S3_BUCKETS');
      await db.videoLibraryIngestRun.delete({ where: { runId: ingestRunId(other) } });
    });

    it('PATCH to NOT_REQUIRED opens TEMPLATE and records the decision', async () => {
      const s3 = await db.videoLibraryItem.findFirstOrThrow({ where: { sourceUrl: S3_URL } });
      const scraped = await call(adminVideoRoute.PATCH, {
        method: 'PATCH',
        token: 'staff',
        params: { id: s3.id },
        body: { licenseScenario: 'SCRAPED', licenseSource: null },
      });
      expect(scraped.status).toBe(200);
      expect(
        (await db.videoLibraryLicense.findUniqueOrThrow({ where: { libraryItemId: s3.id } }))
          .allowedModes,
      ).toEqual(['INSPIRE']);
      const res = await call(adminVideoRoute.PATCH, {
        method: 'PATCH',
        token: 'staff',
        params: { id: s3.id },
        body: { licenseScenario: 'NOT_REQUIRED' },
      });
      expect(res.status).toBe(200);
      const license = await db.videoLibraryLicense.findUniqueOrThrow({
        where: { libraryItemId: s3.id },
      });
      expect(license).toMatchObject({
        scenario: 'NOT_REQUIRED',
        allowedModes: ['TEMPLATE', 'INSPIRE'],
        licenseSource: NOT_REQUIRED_DEFAULT_SOURCE,
      });
    });
  },
);
