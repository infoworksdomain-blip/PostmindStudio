import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as adminIngestRoute from '../../src/app/api/studio/admin/library/ingest/route';
import * as statusRoute from '../../src/app/api/studio/admin/library/ingest/status/route';
import * as categoriesRoute from '../../src/app/api/studio/library/categories/route';
import * as libraryVideosRoute from '../../src/app/api/studio/library/videos/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import {
  categorySlugsFromTree,
  emptyState,
  parseManifest,
  pendingRows,
  seededRandom,
  stratifiedSample,
  validateRows,
  type CorpusState,
} from '../../src/lib/studio/library/corpus-manifest';
import { formatReviewReport } from '../../src/lib/studio/library/corpus-report';
import {
  submitRows,
  waitForRuns,
  type IngestResult,
  type IngestStatus,
  type StudioClient,
} from '../../src/lib/studio/library/corpus-run';
import { seedTaxonomy } from '../../src/lib/studio/library/taxonomy';
import { ingestRunId } from '../../src/lib/studio/services/library';
import { call, tenant } from '../helpers/api-harness';
import {
  briefBody,
  cleanupGolden,
  createProject,
  drain,
  generate,
  LIBRARY_URL_PREFIX,
  ORG_PREFIX,
  startJourney,
} from './journey-kit';

// BACKLOG 9.2 / 9.3 golden journey — corpus tooling end to end: a manifest of fake videos is
// parsed and validated against the live taxonomy (GET /library/categories), a stratified sample
// is submitted through the admin API by the ingest-corpus runner (batches, resumable state), the
// workers ingest it with the operator's NOT_REQUIRED licence, the status endpoint reports it, the
// items are searchable, and one of them drives a TEMPLATE project. Then the "full run" resumes
// from the state file and only submits the rest.

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;

const manifestCsv = [
  'url,title,tags,category,external_id,language',
  `${LIBRARY_URL_PREFIX}corpus-1.mp4,Sourdough at dawn,bread|morning,lifestyle/food/baking,c-1,en`,
  `${LIBRARY_URL_PREFIX}corpus-2.mp4,"Croissants, layered",pastry,lifestyle/food/baking,c-2,fr`,
  `${LIBRARY_URL_PREFIX}corpus-3.mp4,Shop tour,,,c-3,en`,
  `${LIBRARY_URL_PREFIX}corpus-4.mp4,Unknown category,,nope/nope,c-4,en`,
  `http://insecure.example/corpus-5.mp4,Plain http,,,c-5,en`,
  `${LIBRARY_URL_PREFIX}corpus-1.mp4,Duplicate,,,c-6,en`,
].join('\n');

describe.skipIf(!hasDb)('golden journey: corpus ingestion tooling', { timeout: 180_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();
  const corpusFetch = (async (input: string | URL | Request) =>
    new Response(new TextEncoder().encode(`corpus golden bytes ${String(input)}`), {
      headers: { 'content-type': 'video/mp4' },
    })) as typeof fetch;

  beforeAll(async () => {
    await seedTaxonomy(
      db,
      JSON.parse(readFileSync(join(__dirname, '../../prisma/data/library-taxonomy.json'), 'utf8')),
    );
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    setApiDeps(undefined);
    await db.videoLibraryIngestRun.deleteMany({
      where: { sourceUrl: { startsWith: LIBRARY_URL_PREFIX } },
    });
    await cleanupGolden(db, since);
    await db.$disconnect();
  }, HOOK_TIMEOUT_MS);

  /** The runner's StudioClient, backed by the real route handlers instead of HTTP. */
  const routeClient: StudioClient = {
    async categories() {
      const res = await call(categoriesRoute.GET, { token: 'staff' });
      return res.json.data as Array<{ slug: string; children?: unknown }>;
    },
    async ingest(items) {
      const res = await call(adminIngestRoute.POST, {
        method: 'POST',
        token: 'staff',
        body: { items },
      });
      return {
        status: res.status,
        body: res.status === 202 ? (res.json as unknown as IngestResult) : null,
        text: JSON.stringify(res.json),
      };
    },
    async status(query) {
      const res = await call(statusRoute.GET, {
        token: 'staff',
        path: `/api/studio/admin/library/ingest/status?${new URLSearchParams(query).toString()}`,
      });
      expect(res.status).toBe(200);
      return res.json as unknown as IngestStatus;
    },
  };

  it('CO-01 manifest → sample → review → TEMPLATE project → resumed full run', async () => {
    const j = startJourney(
      db,
      'co01',
      { pageFetch: corpusFetch },
      { staff: tenant(`${ORG_PREFIX}-co01`, ['studio:project:read', 'studio:admin:library']) },
    );

    // Validate the manifest against the live taxonomy.
    const parsed = parseManifest(manifestCsv, 'csv');
    const { valid, errors } = validateRows(
      parsed.rows,
      categorySlugsFromTree(await routeClient.categories()),
    );
    expect(valid.map((r) => r.sourceRef)).toEqual(['c-1', 'c-2', 'c-3']);
    expect(errors.map((e) => e.error)).toEqual([
      'unknown category slug "nope/nope"',
      'only https:// and s3:// sources are accepted',
      'duplicate of line 2',
    ]);

    // Sample run: 2 of 3, stratified (one baking, one auto-classified).
    const sample = stratifiedSample(valid, 2, seededRandom(1));
    expect(sample.map((r) => r.category ?? '(auto)').sort()).toEqual([
      '(auto)',
      'lifestyle/food/baking',
    ]);
    const saved: CorpusState[] = [];
    const runnerOptions = {
      client: routeClient,
      licence: { scenario: 'NOT_REQUIRED' as const, source: 'Operator decision 2026-09-27' },
      concurrency: 1,
      maxRetries: 2,
      sleep: async () => undefined,
      random: () => 0.5,
      now: () => new Date(),
      onBatch: async (state: CorpusState) => void saved.push(state),
    };
    let state = await submitRows(sample, emptyState('corpus.csv'), {
      ...runnerOptions,
      sample: true,
    });
    expect(saved).toHaveLength(1);
    expect(Object.values(state.rows).map((r) => r.status)).toEqual(['accepted', 'accepted']);
    await drain(j);

    const { runs, timedOut } = await waitForRuns(
      routeClient,
      sample.map((r) => ingestRunId(r.url)),
      { pollMs: 0, timeoutMs: 0, sleep: async () => undefined, now: Date.now },
    );
    expect(timedOut).toBe(false);
    expect(runs.map((r) => r.state)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    const report = formatReviewReport({
      studioUrl: 'https://studio.test',
      rows: sample,
      runs,
      runIdByUrl: new Map(sample.map((r) => [r.url, state.rows[r.url]?.runId ?? ''])),
      random: seededRandom(2),
      timedOut,
    });
    expect(report).toContain('ingested ok: 2   failed: 0   still running: 0');
    expect(report.match(/https:\/\/studio\.test\/library\/\w+/g)).toHaveLength(2);

    // Ingested with the operator's licence decision, and searchable by category and tag.
    const baking = await db.videoLibraryItem.findFirstOrThrow({
      where: { sourceUrl: `${LIBRARY_URL_PREFIX}corpus-1.mp4` },
      include: { license: true, category: true },
    });
    expect(baking.category.slug).toBe('lifestyle/food/baking');
    expect(baking.license).toMatchObject({
      scenario: 'NOT_REQUIRED',
      licenseSource: 'Operator decision 2026-09-27',
      allowedModes: ['TEMPLATE', 'INSPIRE'],
    });
    const search = await call(libraryVideosRoute.GET, {
      token: 'reader',
      path: '/api/studio/library/videos?category=lifestyle/food&tags=bread&limit=100',
    });
    expect((search.json.data as Array<{ id: string }>).map((v) => v.id)).toContain(baking.id);

    // A TEMPLATE project follows the corpus item's structure.
    const projectId = await createProject(
      j,
      briefBody({
        name: 'Corpus template',
        sourceType: 'LIBRARY_REFERENCE',
        referenceVideoId: baking.id,
        referenceMode: 'TEMPLATE',
      }),
    );
    expect((await generate(j, projectId)).state).toBe('READY_FOR_REVIEW');
    const prompts = j.h.adapters.anthropic.requests.map(
      (r) => (r as { prompt?: string }).prompt ?? '',
    );
    expect(prompts.some((p) => p.includes('STRUCTURE TEMPLATE'))).toBe(true);

    // Full run resumes from the state file: only the row the sample didn't take is submitted.
    const rest = pendingRows(valid, state);
    expect(rest.map((r) => r.sourceRef)).toEqual(['c-2']);
    state = await submitRows(rest, state, runnerOptions);
    await drain(j);
    expect(Object.values(state.rows).every((r) => r.status === 'accepted')).toBe(true);

    const status = await routeClient.status({ windowHours: '1', failures: '10' });
    expect(status.counts.SUCCEEDED).toBeGreaterThanOrEqual(3);
    expect(status.backlog).toEqual({ queued: 0, running: 0 });
  });
});
