import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PrismaClient, type Prisma, type VideoProject } from '@prisma/client';
import { Queue, type Worker } from 'bullmq';
import { logger } from '../../src/lib/logger';
import type { TenantContext } from '../../src/lib/tenant';
import { sealTokens } from '../../src/lib/studio/platforms/tokens';
import { lazyDataKeyProvider } from '../../src/lib/studio/crypto/envelope';
import { createPublisherRegistry } from '../../src/lib/studio/platforms/registry';
import type { MetricsFetcher } from '../../src/lib/studio/analytics/fetchers';
import { createPipelineDeps } from '../../src/lib/studio/pipeline/create-deps';
import type { PipelineDeps } from '../../src/lib/studio/pipeline/deps';
import { createBullJobQueue, jobIds } from '../../src/lib/studio/queue/enqueue';
import { QUEUES, type PollAnalyticsJobData } from '../../src/lib/studio/queue/queues';
import { queuePrefix, redisConnectionFromEnv } from '../../src/lib/studio/queue/redis';
import { startWorkers } from '../../src/lib/studio/queue/worker-host';
import {
  createSimulatedRegistry,
  DEFAULT_ACCOUNT_CONCURRENCY,
  type SimulatedAdapter,
} from '../../src/lib/studio/load-test/fake-providers';
import { assertFakeProvidersAllowed, localOnlyFetch } from '../../src/lib/studio/load-test/guard';
import { createLocalStorage } from '../../src/lib/studio/load-test/local-storage';
import {
  dummyKeyPlatformFetch,
  withFault,
  type ProviderFault,
} from '../../src/lib/studio/load-test/qa-faults';
import { makeSampleMedia, readSample } from '../../src/lib/studio/load-test/sample-media';
import { createProviderRegistry } from '../../src/lib/studio/providers/registry';
import type { ProviderAdapter } from '../../src/lib/studio/providers/interface';
import {
  createProject,
  createProjectInput,
  generateInput,
  generateProject,
} from '../../src/lib/studio/services/projects';

// BACKLOG 20.31 — a STUBBED full-pipeline run on real Redis 7 and Postgres (CI job "pipeline-e2e",
// .github/workflows/pipeline-e2e.yml). It reuses the 20.29 load-test harness (simulated providers,
// local storage, sample media, the fake-provider guard: src/lib/studio/load-test/) and the real
// workers (startWorkers), router, cost guard, quality gate (real FFmpeg) and publishers; only the
// remote calls are replaced. Nothing leaves the machine and no paid API is called.
//
//   STUDIO_FAKE_PROVIDERS=1 npx tsx scripts/qa/pipeline-e2e.ts --scenario full-brief
//
// Scenarios (one process each; flush Redis between them):
//   full-brief        brief → ideation → script → shots → voice/music → composition (Shotstack
//                     stub) → render → quality gate → auto-approve → publish with a DUMMY key
//                     (the platform answers 401: expected friendly failure) → analytics poll
//   slideshow         slideshow slides → plan (images filled) → composition → render → review
//   failover-429      Seedance answers 429 on every submit; the clips come from Kling
//   failover-credits  Seedance is out of credit; the same call fails over to Kling at once
//   cost-cap-project  the project's own budget is tiny: the run pauses (cost_cap_paused)
//   cost-cap-org      the organisation's daily cap is tiny: the run pauses (cost_cap_paused)

const TERMINAL = new Set([
  'READY_FOR_REVIEW',
  'APPROVED',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
  'QUALITY_FAILED',
  'FAILED',
  'REJECTED',
]);
const SCENARIOS = [
  'full-brief',
  'slideshow',
  'failover-429',
  'failover-credits',
  'cost-cap-project',
  'cost-cap-org',
] as const;
type ScenarioName = (typeof SCENARIOS)[number];

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const out = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface World {
  organisationId: string;
  businessId: string;
  connectionId: string;
  tenant: TenantContext;
}

interface Ctx {
  db: PrismaClient;
  deps: PipelineDeps;
  watch: Queue[];
  adapters: SimulatedAdapter[];
  faulty: Record<string, { refused: number }>;
  platformCalls: string[];
  timeoutMs: number;
  tag: string;
}

async function createWorld(ctx: Ctx, label: string): Promise<World> {
  const { db } = ctx;
  const organisationId = `pe-${label}-${ctx.tag}`;
  await db.organization.create({
    data: { id: organisationId, name: `Pipeline QA ${label}`, slug: organisationId },
  });
  // source 'admin' (not 'trial'): the trial's own cost caps would pause a run for another reason.
  await db.orgEntitlement.create({
    data: {
      organisationId,
      tier: 'STANDARD',
      access: 'full',
      source: 'admin',
      reason: 'pipeline e2e 20.31',
    },
  });
  const business = await db.business.create({
    data: { organisationId, name: 'QA Pipeline Bakery', createdByUserId: 'qa-pipeline' },
  });
  // A connected TikTok account whose tokens are DUMMIES (sealed like real ones): the platform
  // refuses them, which is what a dummy production key gets.
  const sealed = await sealTokens(lazyDataKeyProvider(), organisationId, 'tiktok', {
    accessToken: 'dummy-access-token-not-real',
    refreshToken: 'dummy-refresh-token-not-real',
    expiresAt: new Date(Date.now() + 24 * 3_600_000),
    scopes: ['video.publish', 'video.upload'],
  });
  const connection = await db.platformConnection.create({
    data: {
      organisationId,
      businessId: business.id,
      platform: 'tiktok',
      platformAccountId: `tt-${ctx.tag}`,
      platformAccountName: 'QA TikTok (dummy keys)',
      ...sealed,
      scopes: ['video.publish', 'video.upload', 'video.list', 'user.info.basic'],
      state: 'active',
      connectedByUserId: 'qa-pipeline',
      connectedVia: 'studio',
    },
  });
  return {
    organisationId,
    businessId: business.id,
    connectionId: connection.id,
    tenant: {
      userId: 'qa-pipeline',
      organisationId,
      organisation: { id: organisationId, planTier: 'STANDARD' } as TenantContext['organisation'],
      memberships: [],
      capabilities: ['studio:*'],
      role: 'owner',
    },
  };
}

const BRIEF =
  'A 30-second TikTok announcing our weekly sourdough subscription. Warm, friendly tone. Call to action: subscribe on our website.';
const TIKTOK = [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }];

/** Create the project through the real service and start it through the real generate call. */
async function startProject(
  ctx: Ctx,
  world: World,
  input: Record<string, unknown>,
): Promise<string> {
  const parsed = createProjectInput.parse({
    businessId: world.businessId,
    targetFormats: TIKTOK,
    ...input,
  });
  const project = await createProject(ctx.db, world.tenant, parsed);
  await generateProject(
    { db: ctx.db, queue: ctx.deps.queue },
    world.tenant,
    project.id,
    generateInput.parse({}),
  );
  return project.id;
}

/** Poll until `done` holds; returns the states the project passed through (the trail). */
async function waitFor(
  ctx: Ctx,
  projectId: string,
  done: (project: VideoProject) => Promise<boolean> | boolean,
): Promise<{ project: VideoProject; trail: string[]; timedOut: boolean }> {
  const trail: string[] = [];
  const deadline = Date.now() + ctx.timeoutMs;
  for (;;) {
    const project = await ctx.db.videoProject.findUniqueOrThrow({ where: { id: projectId } });
    if (trail[trail.length - 1] !== project.state) trail.push(project.state);
    if (await done(project)) return { project, trail, timedOut: false };
    if (Date.now() > deadline) return { project, trail, timedOut: true };
    await sleep(400);
  }
}

const providerJobs = (ctx: Ctx, organisationId: string) =>
  ctx.db.providerJob.groupBy({
    by: ['provider', 'operation', 'state', 'errorClass'],
    where: { organisationId },
    _count: { _all: true },
  });

type JobRows = Awaited<ReturnType<typeof providerJobs>>;

function countOf(rows: JobRows, where: Partial<JobRows[number]>): number {
  return rows
    .filter((r) => Object.entries(where).every(([k, v]) => r[k as keyof typeof r] === v))
    .reduce((sum, r) => sum + r._count._all, 0);
}

const verify = (name: string, ok: boolean, detail = ''): Check => ({ name, ok, detail });

function describeJobs(rows: JobRows): string {
  return rows
    .map(
      (r) =>
        `${r.provider}/${r.operation}:${r.state}${r.errorClass ? `(${r.errorClass})` : ''}x${r._count._all}`,
    )
    .join(', ');
}

// ---------------------------------------------------------------------------------- scenarios

/** Layers 1-8 for a project that reached review: brief, script, shots, renders, quality gate. */
async function pipelineChecks(ctx: Ctx, project: VideoProject, rows: JobRows): Promise<Check[]> {
  const checks: Check[] = [];
  const brief = await ctx.db.videoBrief.findUnique({ where: { projectId: project.id } });
  checks.push(verify('1 ideation wrote a brief', Boolean(brief?.hook), brief?.hook ?? 'none'));
  const scripts = await ctx.db.videoScript.findMany({
    where: { projectId: project.id },
    include: { shots: true },
  });
  const shots = scripts.flatMap((s) => s.shots);
  checks.push(
    verify(
      '2 script and storyboard',
      scripts.length > 0 && shots.length > 0,
      `${shots.length} shots`,
    ),
  );
  checks.push(
    verify(
      '3 every shot has its asset',
      shots.length > 0 && shots.every((s) => s.state === 'READY'),
      shots.map((s) => `${s.visualTreatment}:${s.state}`).join(' '),
    ),
  );
  checks.push(
    verify(
      '4 voice (ElevenLabs stub)',
      countOf(rows, { provider: 'elevenlabs', state: 'SUCCEEDED' }) > 0,
      describeJobs(rows.filter((r) => r.provider === 'elevenlabs')),
    ),
  );
  checks.push(
    verify(
      '5 music (stub)',
      countOf(rows, { provider: 'elevenlabs-music', state: 'SUCCEEDED' }) > 0,
      describeJobs(rows.filter((r) => r.provider === 'elevenlabs-music')),
    ),
  );
  checks.push(
    verify(
      '6 composition (Shotstack stub)',
      countOf(rows, { provider: 'shotstack', state: 'SUCCEEDED' }) > 0,
      describeJobs(rows.filter((r) => r.provider === 'shotstack')),
    ),
  );
  const renders = await ctx.db.videoRender.findMany({ where: { projectId: project.id } });
  checks.push(
    verify(
      '7 one render per target format',
      renders.length === TIKTOK.length,
      `${renders.length} render(s)`,
    ),
  );
  checks.push(
    verify(
      '8 quality gate passed (real FFmpeg)',
      renders.length > 0 && renders.every((r) => r.qualityCheckState === 'PASSED'),
      renders.map((r) => `${r.targetPlatform}:${r.qualityCheckState}`).join(' '),
    ),
  );
  return checks;
}

async function fullBrief(ctx: Ctx): Promise<Check[]> {
  const world = await createWorld(ctx, 'full');
  const projectId = await startProject(ctx, world, {
    name: 'QA full pipeline',
    brief: { rawInput: BRIEF },
    reviewPolicy: 'AUTO_APPROVE',
    publishPolicy: 'AUTO_ON_APPROVAL',
    autoPublish: { targets: [{ platform: 'tiktok', connectionId: world.connectionId }] },
  });
  // A month-plan style owner pre-approval lets auto-approve run for a brand-new creator
  // (review-policy.ts ownerPreApproved); every quality and safety check still applies.
  const existing = await ctx.db.videoProject.findUniqueOrThrow({ where: { id: projectId } });
  await ctx.db.videoProject.update({
    where: { id: projectId },
    data: {
      metadata: {
        ...((existing.metadata ?? {}) as Prisma.JsonObject),
        contentPlan: { preApproved: true },
      },
    },
  });
  const run = await waitFor(ctx, projectId, async (p) => {
    if (!TERMINAL.has(p.state) || p.state === 'READY_FOR_REVIEW') return false;
    const pubs = await ctx.db.videoPublication.findMany({ where: { projectId } });
    return pubs.length > 0 && pubs.every((x) => x.state === 'FAILED' || x.state === 'PUBLISHED');
  });
  const rows = await providerJobs(ctx, world.organisationId);
  const checks: Check[] = [
    verify('run finished', !run.timedOut, `trail ${run.trail.join(' > ')}`),
    ...(await pipelineChecks(ctx, run.project, rows)),
  ];
  const meta = (run.project.metadata ?? {}) as { review?: { decision?: string } };
  checks.push(
    verify(
      '9 auto-approved',
      meta.review?.decision === 'auto_approved',
      JSON.stringify(meta.review),
    ),
  );
  const approvals = await ctx.db.approvalTask.findMany({ where: { projectId } });
  checks.push(
    verify(
      '9 approval recorded for the automatic approver',
      approvals.some((a) => /^system:/.test(a.resolvedByUserId ?? '')),
      approvals.map((a) => `${a.state}:${a.resolvedByUserId}`).join(' '),
    ),
  );
  const pubs = await ctx.db.videoPublication.findMany({ where: { projectId } });
  const failed = pubs.find((p) => p.state === 'FAILED');
  checks.push(
    verify(
      '10 publish with a dummy key fails with a friendly reason',
      Boolean(failed) &&
        /^[a-z_]+\/[a-z_]+: /.test(failed?.errorReason ?? '') &&
        !/ConfigurationError|ECONN|stack|at \w+ \(/.test(failed?.errorReason ?? ''),
      `${failed?.platform}: ${failed?.errorCode} / ${failed?.errorReason}`,
    ),
  );
  checks.push(
    verify(
      '10 the platform stub was asked, nothing real was',
      ctx.platformCalls.length > 0 && ctx.platformCalls.every((h) => h === 'open.tiktokapis.com'),
      [...new Set(ctx.platformCalls)].join(', '),
    ),
  );
  return [...checks, ...(await analyticsChecks(ctx, world, run.project))];
}

/** Analytics: poll a published post (a pre-published stand-in; the dummy-key post never goes live). */
async function analyticsChecks(ctx: Ctx, world: World, project: VideoProject): Promise<Check[]> {
  const render = await ctx.db.videoRender.findFirst({ where: { projectId: project.id } });
  if (!render) return [verify('11 analytics', false, 'no render to attach a published post to')];
  const publication = await ctx.db.videoPublication.create({
    data: {
      organisationId: world.organisationId,
      projectId: project.id,
      renderId: render.id,
      platform: 'tiktok',
      platformAccountId: `tt-${ctx.tag}`,
      state: 'PUBLISHED',
      platformPostId: '7300000000000000001',
      platformUrl: 'https://www.tiktok.com/@qa/video/7300000000000000001',
      publishedAt: new Date(Date.now() - 3_600_000),
      caption: 'Stand-in published post for the analytics poll',
      metadata: { connectionId: world.connectionId },
    },
  });
  const poll: PollAnalyticsJobData = {
    projectId: project.id,
    organisationId: world.organisationId,
    runId: randomUUID(),
    planTier: 'STANDARD',
    publicationId: publication.id,
    pollNumber: 0,
  };
  await ctx.deps.queue.add('poll-publication-analytics', poll, {
    jobId: jobIds.pollAnalytics(poll),
  });
  const deadline = Date.now() + 60_000;
  let rows = 0;
  while (Date.now() < deadline && rows === 0) {
    rows = await ctx.db.videoAnalytic.count({ where: { publicationId: publication.id } });
    if (rows === 0) await sleep(400);
  }
  const latest = await ctx.db.videoAnalytic.findFirst({
    where: { publicationId: publication.id },
    orderBy: { bucketAt: 'desc' },
  });
  return [
    verify('11 analytics snapshot stored (hour and day buckets)', rows >= 2, `${rows} row(s)`),
    verify(
      '11 analytics numbers are the poll result',
      latest?.views === 1200,
      `views ${latest?.views}`,
    ),
  ];
}

/**
 * 29 s of slides (hook card, six photo slides at the 4 s maximum, closing card): a slideshow's
 * length is the sum of its slides, and the stub Shotstack render is 30 s, so the quality gate's
 * duration check (target ±2 s) passes. Photos are found by their query: library, stock, then generated.
 */
function slideshowSlides() {
  const points = [
    '48-hour ferment',
    'Baked at dawn',
    'Local flour',
    'Crackling crust',
    'Weekly delivery',
    'No additives',
  ];
  const effects = ['zoomIn', 'zoomOut', 'slideLeft', 'slideRight', 'slideUp', 'slideDown'] as const;
  return [
    { slideType: 'TEXT_CARD', durationSec: 2.5, content: { role: 'hook', text: 'Why sourdough?' } },
    ...points.map((text, i) => ({
      slideType: 'IMAGE_KENBURNS',
      durationSec: 4,
      transitionIn: 'fade',
      kenBurnsSpec: { effect: effects[i] },
      content: { role: 'body', text, imageQuery: text },
    })),
    { slideType: 'TEXT_CARD', durationSec: 2.5, content: { role: 'cta', text: 'Order today' } },
  ];
}

async function slideshow(ctx: Ctx): Promise<Check[]> {
  const world = await createWorld(ctx, 'slides');
  const projectId = await startProject(ctx, world, {
    name: 'QA slideshow',
    sourceType: 'SLIDESHOW',
    slideshow: { topic: 'Five reasons people love our sourdough', slides: slideshowSlides() },
  });
  const run = await waitFor(ctx, projectId, (p) => TERMINAL.has(p.state));
  const rows = await providerJobs(ctx, world.organisationId);
  const slides = await ctx.db.slideshowSlide.findMany({ where: { projectId } });
  const renders = await ctx.db.videoRender.findMany({ where: { projectId } });
  return [
    verify(
      'run reached review',
      run.project.state === 'READY_FOR_REVIEW',
      `trail ${run.trail.join(' > ')}; ${run.project.errorReason ?? ''}`,
    ),
    verify('slides kept (8)', slides.length === 8, `${slides.length}`),
    verify(
      'image slides have an image (library, stock or generated)',
      slides.filter((s) => s.slideType === 'IMAGE_KENBURNS').every((s) => s.imageAssetId),
      slides.map((s) => `${s.slideType}:${s.imageAssetId ? 'img' : 'none'}`).join(' '),
    ),
    verify(
      'no AI video clip was bought for a slideshow',
      countOf(rows, { operation: 'text_to_video' }) === 0,
      describeJobs(rows),
    ),
    verify(
      'composition (Shotstack stub)',
      countOf(rows, { provider: 'shotstack', state: 'SUCCEEDED' }) > 0,
      describeJobs(rows.filter((r) => r.provider === 'shotstack')),
    ),
    verify(
      'rendered and passed the quality gate',
      renders.length > 0 && renders.every((r) => r.qualityCheckState === 'PASSED'),
      renders.map((r) => r.qualityCheckState).join(' '),
    ),
  ];
}

async function failover(ctx: Ctx, fault: ProviderFault): Promise<Check[]> {
  const world = await createWorld(ctx, fault === 'rate_limited' ? 'f429' : 'fcredit');
  const projectId = await startProject(ctx, world, {
    name: `QA failover ${fault}`,
    brief: { rawInput: BRIEF },
  });
  const run = await waitFor(ctx, projectId, (p) => TERMINAL.has(p.state));
  const rows = await providerJobs(ctx, world.organisationId);
  const kling = countOf(rows, {
    provider: 'kling',
    operation: 'text_to_video',
    state: 'SUCCEEDED',
  });
  const seedanceDone = countOf(rows, { provider: 'seedance', state: 'SUCCEEDED' });
  const refused = ctx.faulty.seedance?.refused ?? 0;
  const checks = [
    verify('Seedance refused the submit', refused > 0, `${refused} refusal(s)`),
    verify(
      'no Seedance clip was produced',
      seedanceDone === 0,
      describeJobs(rows.filter((r) => r.provider === 'seedance')),
    ),
    verify(
      'Kling produced the AI clips',
      kling > 0,
      describeJobs(rows.filter((r) => r.provider === 'kling')),
    ),
    verify(
      'the video still reached review',
      run.project.state === 'READY_FOR_REVIEW',
      `trail ${run.trail.join(' > ')}; ${run.project.errorReason ?? ''}`,
    ),
  ];
  if (fault === 'insufficient_credits') {
    // Held out of routing: the second and later shots do not call Seedance again (20.11).
    checks.push(
      verify(
        'Seedance was held out after the first refusal',
        refused <= 2,
        `${refused} refusal(s) across all clips`,
      ),
    );
  }
  return checks;
}

async function costCap(ctx: Ctx, kind: 'project' | 'org'): Promise<Check[]> {
  const world = await createWorld(ctx, kind === 'project' ? 'cap-p' : 'cap-o');
  const projectId = await startProject(ctx, world, {
    name: `QA cost cap ${kind}`,
    brief: { rawInput: BRIEF },
    ...(kind === 'project' && { costBudgetPence: 40 }),
  });
  const run = await waitFor(ctx, projectId, (p) => TERMINAL.has(p.state));
  const rows = await providerJobs(ctx, world.organisationId);
  const spent = await ctx.db.providerJob.aggregate({
    where: { organisationId: world.organisationId },
    _sum: { costPence: true },
  });
  const cap = kind === 'project' ? 40 : 60;
  // Give any in-flight job time to show up, then count again: a paused run submits nothing more.
  const before = await ctx.db.providerJob.count({
    where: { organisationId: world.organisationId },
  });
  await sleep(4_000);
  const submitsAfter =
    (await ctx.db.providerJob.count({ where: { organisationId: world.organisationId } })) - before;
  return [
    verify(
      'the run paused instead of overspending',
      run.project.state === 'FAILED' && /^cost_cap_paused/.test(run.project.errorReason ?? ''),
      `${run.project.state}: ${run.project.errorReason}`,
    ),
    verify(
      'no render was produced',
      (await ctx.db.videoRender.count({ where: { projectId } })) === 0,
      describeJobs(rows),
    ),
    verify(
      'spend stayed near the cap',
      (spent._sum.costPence ?? 0) <= cap * 2,
      `${spent._sum.costPence ?? 0}p spent, cap ${cap}p`,
    ),
    verify(
      'nothing keeps spending after the pause',
      submitsAfter === 0,
      `${submitsAfter} later provider job(s)`,
    ),
  ];
}

// ---------------------------------------------------------------------------------- plumbing

function envFor(scenario: ScenarioName): Record<string, string> {
  if (scenario === 'cost-cap-org') return { STUDIO_ORG_DAILY_CAP_PENCE_STANDARD: '60' };
  return {};
}

function adaptersFor(
  scenario: ScenarioName,
  adapters: SimulatedAdapter[],
  faulty: Ctx['faulty'],
): ProviderAdapter[] {
  const fault: ProviderFault | undefined =
    scenario === 'failover-429'
      ? 'rate_limited'
      : scenario === 'failover-credits'
        ? 'insufficient_credits'
        : undefined;
  return adapters.map((adapter) => {
    if (!fault || adapter.providerId !== 'seedance') return adapter;
    const wrapped = withFault(adapter, fault);
    faulty.seedance = wrapped.counters;
    return wrapped.adapter;
  });
}

const stubMetrics: MetricsFetcher = {
  platform: 'tiktok',
  async fetch() {
    return { snapshot: { views: 1200, likes: 80, comments: 7, shares: 3 } };
  },
};

function renderMarkdown(scenario: string, checks: Check[], seconds: number): string {
  const flat = (text: string) => text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/');
  const rows = checks.map((c) => `| ${c.ok ? 'PASS' : 'FAIL'} | ${c.name} | ${flat(c.detail)} |`);
  return [
    `# Stubbed pipeline run: ${scenario}`,
    '',
    `Real Redis, Postgres, workers, router, cost guard and FFmpeg; simulated providers (${Math.round(seconds)} s).`,
    '',
    '| Result | Check | Detail |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      scenario: { type: 'string', default: 'full-brief' },
      'time-scale': { type: 'string', default: '0.02' },
      'timeout-min': { type: 'string', default: '8' },
      out: { type: 'string', default: 'ops/results/pipeline-e2e' },
    },
  });
  const scenario = args.scenario as ScenarioName;
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario ${String(args.scenario)}`);
  assertFakeProvidersAllowed(process.env);
  // Dummy social tokens are sealed with a throw-away local master key (never used elsewhere).
  process.env.STUDIO_LOCAL_MASTER_KEY ||= randomBytes(32).toString('base64');
  Object.assign(process.env, envFor(scenario));
  const timeScale = Number(args['time-scale']);
  const tag = randomUUID().slice(0, 6);
  const startedAt = Date.now();

  const work = join(tmpdir(), `studio-qa-pipeline-${tag}`);
  const media = await makeSampleMedia(join(work, 'samples'), process.env.FFMPEG_PATH || 'ffmpeg');
  const local = await createLocalStorage(join(work, 'objects'));
  const put = async (path: string, key: string, contentType: string) =>
    (await local.storage.put({ bucket: 'samples', key, body: await readSample(path), contentType }))
      .url;
  const clipUrl = await put(media.clip, 'clip.mp4', 'video/mp4');
  const renderUrl = await put(media.render, 'render.mp4', 'video/mp4');

  const db = new PrismaClient();
  const connection = redisConnectionFromEnv();
  const queue = createBullJobQueue(connection);
  const base = createPipelineDeps({ db, queue });
  const profile = {
    timeScale,
    rateLimitedRatio: 0,
    failRatio: 0,
    accountConcurrency: DEFAULT_ACCOUNT_CONCURRENCY,
    random: Math.random,
    now: Date.now,
  };
  const { adapters } = createSimulatedRegistry({
    profile,
    media: {
      clipUrl,
      renderUrl,
      voice: await readSample(media.voice),
      music: await readSample(media.music),
      png: await readSample(media.still),
    },
    storage: local.storage,
    assetsBucket: base.config.assetsBucket,
  });
  const faulty: Ctx['faulty'] = {};
  const registry = createProviderRegistry(adaptersFor(scenario, adapters, faulty));
  const fetchLocal = localOnlyFetch();
  const platformCalls: string[] = [];
  const platformFetch = dummyKeyPlatformFetch(globalThis.fetch, (host) => platformCalls.push(host));
  const deps: PipelineDeps = {
    ...base,
    registry,
    registryFor: undefined,
    providerRatings: undefined,
    storage: local.storage,
    fetch: fetchLocal,
    scan: { ...base.scan, pageFetch: fetchLocal, stock: () => ({ primary: [], fallback: [] }) },
    metrics: { tiktok: stubMetrics },
    publishing: {
      ...base.publishing,
      storage: local.storage,
      publishers: createPublisherRegistry({ fetchImpl: platformFetch, sleep, now: Date.now }),
    },
    config: {
      ...base.config,
      defaultVoiceId: base.config.defaultVoiceId ?? 'simulated-voice',
      providerPollIntervalMs: Math.max(250, Math.round(5_000 * timeScale)),
    },
  };

  const queues = [QUEUES.orchestration, QUEUES.assets, QUEUES.publish, QUEUES.analytics];
  const workers: Worker[] = startWorkers({ connection, deps, queues });
  const watch = queues.map((name) => new Queue(name, { connection, prefix: queuePrefix() }));
  const ctx: Ctx = {
    db,
    deps,
    watch,
    adapters,
    faulty,
    platformCalls,
    timeoutMs: Number(args['timeout-min']) * 60_000,
    tag,
  };

  let checks: Check[];
  try {
    const runner: Record<ScenarioName, (c: Ctx) => Promise<Check[]>> = {
      'full-brief': fullBrief,
      slideshow,
      'failover-429': (c) => failover(c, 'rate_limited'),
      'failover-credits': (c) => failover(c, 'insufficient_credits'),
      'cost-cap-project': (c) => costCap(c, 'project'),
      'cost-cap-org': (c) => costCap(c, 'org'),
    };
    checks = await runner[scenario](ctx);
  } catch (err) {
    logger.error({ err }, 'scenario crashed');
    checks = [
      verify('scenario ran to the end', false, err instanceof Error ? err.message : String(err)),
    ];
  }

  const md = renderMarkdown(scenario, checks, (Date.now() - startedAt) / 1000);
  await mkdir(args.out ?? '.', { recursive: true });
  await writeFile(join(args.out ?? '.', `${scenario}.md`), md);
  await writeFile(join(args.out ?? '.', `${scenario}.json`), JSON.stringify(checks, null, 2));
  out(md);

  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(watch.map((q) => q.close()));
  await queue.close();
  await local.close();
  await db.$disconnect();
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/qa/pipeline-e2e.ts')) {
  main().catch((err: unknown) => {
    logger.error({ err }, 'pipeline e2e failed');
    process.exit(1);
  });
}
