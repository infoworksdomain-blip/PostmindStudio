import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { Queue, type Worker } from 'bullmq';
import { logger } from '../../src/lib/logger';
import { createPipelineDeps } from '../../src/lib/studio/pipeline/create-deps';
import type { PipelineDeps } from '../../src/lib/studio/pipeline/deps';
import { getMetrics } from '../../src/lib/studio/observability/metrics';
import { createBullJobQueue, jobIds } from '../../src/lib/studio/queue/enqueue';
import { QUEUES, type ProjectJobData } from '../../src/lib/studio/queue/queues';
import { queuePrefix, redisConnectionFromEnv } from '../../src/lib/studio/queue/redis';
import { concurrencyFor, startWorkers } from '../../src/lib/studio/queue/worker-host';
import type { PlanTier } from '../../src/lib/studio/providers/router';
import {
  createSimulatedRegistry,
  DEFAULT_ACCOUNT_CONCURRENCY,
  type SimulatedAdapter,
} from '../../src/lib/studio/load-test/fake-providers';
import { assertFakeProvidersAllowed, localOnlyFetch } from '../../src/lib/studio/load-test/guard';
import { createLocalStorage } from '../../src/lib/studio/load-test/local-storage';
import {
  READY_STATES,
  renderMarkdown,
  summarise,
  type ProjectOutcome,
} from '../../src/lib/studio/load-test/report';
import { makeSampleMedia, readSample } from '../../src/lib/studio/load-test/sample-media';
import { concurrencyLimitsFromEnv } from '../../src/lib/studio/providers/provider-concurrency';

// BACKLOG 20.29 — pipeline load test with SIMULATED providers (runbooks/load-testing.md).
//
// Runs the real pipeline — real Postgres, real BullMQ workers on Redis 5+, real router / tracking /
// cost guard / circuit breakers / concurrency caps, real FFmpeg checks on small sample media — with
// every provider replaced by a simulation (load-test/fake-providers.ts). Nothing leaves the
// machine: the pipeline's fetch only reaches 127.0.0.1 (guard.ts localOnlyFetch).
//
//   STUDIO_FAKE_PROVIDERS=1 npx tsx scripts/load/pipeline-load.ts --videos 50 --orgs 10 \
//     --heavy-share 0.5 --time-scale 0.1 --scenario burst-50
//   … --attach --accounts load-test/out/accounts.json   # process what the API (k6) enqueued
//
// Writes <out>/<scenario>.json and <scenario>.md (default out: ops/results/load-test).

const TERMINAL = new Set(['READY_FOR_REVIEW', 'APPROVED', 'QUALITY_FAILED', 'FAILED', 'REJECTED']);
const DEFAULT_BUDGET_PENCE: Record<PlanTier, number> = {
  BASIC: 350,
  STANDARD: 400,
  PLUS: 600,
  ENTERPRISE: 600,
};

const out = (line: string) => process.stdout.write(`${line}\n`);

interface Sample {
  t: number;
  queues: Record<string, Record<string, number>>;
  rssMb: number;
  heapMb: number;
  cpuPct: number;
  ffmpeg: { count: number; rssMb: number };
  db: { total: number; active: number; idle: number };
  activeProjects: number;
}

async function ffmpegChildren(): Promise<{ count: number; rssMb: number }> {
  // Linux only (CI and the VPS); elsewhere the field stays 0.
  const dirs = await readdir('/proc').catch(() => [] as string[]);
  let count = 0;
  let rssKb = 0;
  for (const pid of dirs.filter((d) => /^\d+$/.test(d))) {
    const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
    if (!/^Name:\s+ff(mpeg|probe)/m.test(status)) continue;
    count += 1;
    rssKb += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
  }
  return { count, rssMb: Math.round(rssKb / 1024) };
}

async function dbConnections(db: PrismaClient): Promise<Sample['db']> {
  const rows = await db.$queryRaw<Array<{ state: string | null; n: number }>>`
    SELECT state, count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() GROUP BY state`;
  const n = (s: string) => rows.find((r) => r.state === s)?.n ?? 0;
  return { total: rows.reduce((sum, r) => sum + r.n, 0), active: n('active'), idle: n('idle') };
}

async function createOrganisations(db: PrismaClient, count: number, tier: PlanTier, tag: string) {
  const orgs: Array<{ id: string; businessId: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const id = `lt-${tag}-${i}-${randomUUID().slice(0, 6)}`;
    await db.organization.create({ data: { id, name: `Load test ${tag} ${i}`, slug: id } });
    // source 'admin' (not 'trial'): trial cost caps would pause a load test, not the pipeline.
    await db.orgEntitlement.create({
      data: {
        organisationId: id,
        tier,
        access: 'full',
        source: 'admin',
        reason: 'load test 20.29',
      },
    });
    const business = await db.business.create({
      data: { organisationId: id, name: `Load test bakery ${i}`, createdByUserId: 'load-test' },
    });
    orgs.push({ id, businessId: business.id });
  }
  return orgs;
}

/** "seedance=10,kling=40" → { seedance: 10, kling: 40 } (simulated account concurrency). */
export function parseAccounts(raw: string): Record<string, number> {
  return Object.fromEntries(
    raw
      .split(',')
      .map((pair) => pair.split('=').map((s) => s.trim()))
      .filter(([id, n]) => id && Number.isInteger(Number(n)) && Number(n) > 0)
      .map(([id, n]) => [id ?? '', Number(n)]),
  );
}

/** How many videos each organisation starts: one heavy organisation, the rest round-robin. */
export function videosPerOrganisation(videos: number, orgs: number, heavyShare: number): number[] {
  const heavy = orgs > 1 ? Math.round(videos * heavyShare) : videos;
  const rest = videos - heavy;
  return Array.from({ length: orgs }, (_, i) =>
    i === 0 ? heavy : Math.floor(rest / (orgs - 1)) + (i - 1 < rest % (orgs - 1) ? 1 : 0),
  );
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      scenario: { type: 'string', default: 'burst' },
      videos: { type: 'string', default: '10' },
      orgs: { type: 'string', default: '5' },
      'heavy-share': { type: 'string', default: '0.5' },
      tier: { type: 'string', default: 'STANDARD' },
      'time-scale': { type: 'string', default: '0.1' },
      'rate-limited-ratio': { type: 'string', default: '0.05' },
      'fail-ratio': { type: 'string', default: '0.02' },
      // Simulated provider accounts, e.g. seedance=10 (a BytePlus enterprise account).
      account: { type: 'string', default: process.env.LOAD_TEST_ACCOUNTS ?? '' },
      'timeout-min': { type: 'string', default: '60' },
      out: { type: 'string', default: 'ops/results/load-test' },
      attach: { type: 'boolean', default: false },
      accounts: { type: 'string' },
      'done-file': { type: 'string' },
      assert: { type: 'boolean', default: false },
    },
  });
  assertFakeProvidersAllowed(process.env);
  const timeScale = Number(args['time-scale']);
  const tier = args.tier as PlanTier;
  const scenario = args.scenario ?? 'burst';
  const tag = randomUUID().slice(0, 6);

  // ---- local storage + sample media ---------------------------------------------------------
  const work = join(tmpdir(), `studio-load-${tag}`);
  const media = await makeSampleMedia(join(work, 'samples'), process.env.FFMPEG_PATH || 'ffmpeg');
  const local = await createLocalStorage(join(work, 'objects'));
  const putSample = async (path: string, key: string, contentType: string) =>
    (
      await local.storage.put({
        bucket: 'samples',
        key,
        body: await readSample(path),
        contentType,
      })
    ).url;
  const clipUrl = await putSample(media.clip, 'clip.mp4', 'video/mp4');
  const renderUrl = await putSample(media.render, 'render.mp4', 'video/mp4');

  // ---- pipeline deps: production wiring, providers / storage / fetch replaced ----------------
  // Slot retries run in real time while provider latencies are scaled: scale the retry too, or the
  // report would count 10–20 s real waits as 100–200 s simulated ones.
  process.env.STUDIO_PROVIDER_SLOT_RETRY_MS ??= String(
    Math.max(100, Math.round(10_000 * timeScale)),
  );
  const db = new PrismaClient();
  const connection = redisConnectionFromEnv();
  const queue = createBullJobQueue(connection);
  const base = createPipelineDeps({ db, queue });
  const profile = {
    timeScale,
    rateLimitedRatio: Number(args['rate-limited-ratio']),
    failRatio: Number(args['fail-ratio']),
    accountConcurrency: { ...DEFAULT_ACCOUNT_CONCURRENCY, ...parseAccounts(args.account ?? '') },
    random: Math.random,
    now: Date.now,
  };
  const { registry, adapters } = createSimulatedRegistry({
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
  const fetchLocal = localOnlyFetch();
  const deps: PipelineDeps = {
    ...base,
    registry,
    registryFor: undefined,
    providerRatings: undefined,
    storage: local.storage,
    fetch: fetchLocal,
    scan: { ...base.scan, pageFetch: fetchLocal, stock: () => ({ primary: [], fallback: [] }) },
    publishing: { ...base.publishing, storage: local.storage },
    config: {
      ...base.config,
      // Narration needs a voice; the simulated TTS accepts any id.
      defaultVoiceId: base.config.defaultVoiceId ?? 'simulated-voice',
      providerPollIntervalMs: Math.max(250, Math.round(5_000 * timeScale)),
    },
  };

  // ---- the work: a burst of new projects, or whatever the API enqueued (--attach) ------------
  const startedAt = new Map<string, number>();
  let trackedOrgs: string[] = [];
  if (args.attach) {
    const accounts = JSON.parse(await readFile(args.accounts ?? '', 'utf8')) as Array<{
      organisationId: string;
    }>;
    trackedOrgs = [...new Set(accounts.map((a) => a.organisationId))];
  } else {
    const perOrg = videosPerOrganisation(
      Number(args.videos),
      Number(args.orgs),
      Number(args['heavy-share']),
    );
    const orgs = await createOrganisations(db, perOrg.length, tier, tag);
    trackedOrgs = orgs.map((o) => o.id);
    const jobs: ProjectJobData[] = [];
    for (const [i, org] of orgs.entries()) {
      for (let n = 0; n < (perOrg[i] ?? 0); n += 1) {
        const runId = randomUUID();
        const project = await db.videoProject.create({
          data: {
            organisationId: org.id,
            businessId: org.businessId,
            createdByUserId: 'load-test',
            name: `Load test ${scenario} ${i}.${n}`,
            description:
              'A 30-second TikTok announcing our weekly sourdough subscription. Warm, friendly tone. Call to action: subscribe on our website.',
            state: 'QUEUED',
            sourceType: 'BRIEF',
            targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 30 }],
            costBudgetPence: DEFAULT_BUDGET_PENCE[tier],
            metadata: { runId, loadTest: scenario },
          },
        });
        jobs.push({ projectId: project.id, organisationId: org.id, runId, planTier: tier });
      }
    }
    // Everyone presses "generate" in the same second.
    const t0 = Date.now();
    await Promise.all(
      jobs.map((job) =>
        queue.add('plan-project', job, { jobId: jobIds.planProject(job) }).then(() => {
          startedAt.set(job.projectId, t0);
        }),
      ),
    );
    out(`${scenario}: ${jobs.length} projects across ${orgs.length} organisations enqueued`);
  }

  // 23.6: compose / render jobs run on their own lane.
  const queues = [QUEUES.orchestration, QUEUES.render, QUEUES.assets];
  const workers: Worker[] = startWorkers({ connection, deps, queues });
  const watch = queues.map((name) => new Queue(name, { connection, prefix: queuePrefix() }));
  out(
    `workers: ${queues.map((q) => `${q}=${concurrencyFor(q)}`).join(', ')}; time scale ${timeScale}`,
  );

  // ---- sample until every tracked project is terminal (or the timeout) -----------------------
  const samples: Sample[] = [];
  const finishedAt = new Map<string, number>();
  const firstWaitAt = new Map<string, number>();
  const harnessStart = new Date();
  const deadline = Date.now() + Number(args['timeout-min']) * 60_000;
  // --attach: only runs the API started while the harness ran (not seeded or never-generated drafts).
  const tracked = args.attach
    ? {
        organisationId: { in: trackedOrgs },
        deletedAt: null,
        createdAt: { gte: harnessStart },
        state: { not: 'DRAFT' as const },
      }
    : { organisationId: { in: trackedOrgs }, deletedAt: null };
  let cpu = process.cpuUsage();
  let cpuAt = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 5_000));
    const projects = await db.videoProject.findMany({
      where: tracked,
      select: { id: true, state: true, metadata: true, createdAt: true },
    });
    const now = Date.now();
    for (const p of projects) {
      // Attached: the first sighting out of DRAFT (≤ 5 s after the generate call).
      if (!startedAt.has(p.id)) startedAt.set(p.id, args.attach ? now : p.createdAt.getTime());
      if (TERMINAL.has(p.state) && !finishedAt.has(p.id)) finishedAt.set(p.id, now);
      const meta = p.metadata as { providerWait?: { at?: string } } | null;
      if (meta?.providerWait?.at && !firstWaitAt.has(p.id)) {
        firstWaitAt.set(p.id, Date.parse(meta.providerWait.at));
      }
    }
    const usage = process.cpuUsage(cpu);
    const cpuPct = ((usage.user + usage.system) / 1_000 / Math.max(1, now - cpuAt)) * 100;
    cpu = process.cpuUsage();
    cpuAt = now;
    const memory = process.memoryUsage();
    const counts = await Promise.all(watch.map((q) => q.getJobCounts()));
    const active = projects.filter((p) => !TERMINAL.has(p.state)).length;
    samples.push({
      t: now,
      queues: Object.fromEntries(watch.map((q, i) => [q.name, counts[i] ?? {}])),
      rssMb: Math.round(memory.rss / 1_048_576),
      heapMb: Math.round(memory.heapUsed / 1_048_576),
      cpuPct: Math.round(cpuPct),
      ffmpeg: await ffmpegChildren(),
      db: await dbConnections(db),
      activeProjects: active,
    });
    const last = samples[samples.length - 1];
    out(
      `[${new Date(now).toISOString()}] active ${active}/${projects.length} rss ${last?.rssMb} MB cpu ${last?.cpuPct}% db ${last?.db.total} assets ${JSON.stringify(counts[1])}`,
    );
    const apiDone =
      !args['done-file'] ||
      (await readFile(args['done-file']).then(
        () => true,
        () => false,
      ));
    if ((projects.length > 0 && active === 0 && apiDone) || now > deadline) break;
  }

  // ---- results --------------------------------------------------------------------------------
  const projects = await db.videoProject.findMany({
    where: tracked,
    select: {
      id: true,
      organisationId: true,
      state: true,
      errorReason: true,
      costActualPence: true,
    },
  });
  const outcomes: ProjectOutcome[] = projects.map((p) => ({
    projectId: p.id,
    organisationId: p.organisationId,
    startedAt: startedAt.get(p.id) ?? Date.now(),
    finishedAt: finishedAt.get(p.id),
    finalState: p.state,
    errorReason: p.errorReason,
    costPence: p.costActualPence,
    firstWaitAt: firstWaitAt.get(p.id),
  }));
  const summary = summarise(outcomes);
  const providerJobs = await db.providerJob.groupBy({
    by: ['provider', 'state', 'errorClass'],
    where: { organisationId: { in: trackedOrgs } },
    _count: { _all: true },
  });
  const deferred = (await getMetrics().jobs.get()).values
    .filter((v) => v.labels.outcome === 'deferred')
    .reduce((sum, v) => sum + v.value, 0);
  const limits = concurrencyLimitsFromEnv(process.env);
  const providers = Object.fromEntries(
    adapters.map((a: SimulatedAdapter) => [
      a.providerId,
      { ...a.stats, cap: limits(a.providerId) ?? null },
    ]),
  );
  const peak = (key: 'rssMb' | 'heapMb' | 'cpuPct') => Math.max(0, ...samples.map((s) => s[key]));
  const resources = {
    peakRssMb: peak('rssMb'),
    peakHeapMb: peak('heapMb'),
    peakCpuPct: peak('cpuPct'),
    peakFfmpeg: Math.max(0, ...samples.map((s) => s.ffmpeg.count)),
    peakFfmpegRssMb: Math.max(0, ...samples.map((s) => s.ffmpeg.rssMb)),
    peakDbConnections: Math.max(0, ...samples.map((s) => s.db.total)),
    peakAssetsWaiting: Math.max(
      0,
      ...samples.map((s) => {
        const c = s.queues[QUEUES.assets] ?? {};
        return (c.waiting ?? 0) + (c.prioritized ?? 0) + (c.delayed ?? 0);
      }),
    ),
    storageMb: Math.round(local.bytesWritten() / 1_048_576),
  };
  const waited = outcomes.filter((o) => o.firstWaitAt !== undefined).length;
  const report = {
    scenario,
    at: new Date().toISOString(),
    timeScale,
    tier,
    attach: args.attach,
    workerConcurrency: Object.fromEntries(queues.map((q) => [q, concurrencyFor(q)])),
    summary,
    providers,
    providerJobs: providerJobs.map((r) => ({
      provider: r.provider,
      state: r.state,
      errorClass: r.errorClass,
      count: r._count._all,
    })),
    deferredJobRuns: deferred,
    projectsShownQueued: waited,
    resources,
    samples,
  };
  await mkdir(args.out ?? '.', { recursive: true });
  await writeFile(join(args.out ?? '.', `${scenario}.json`), JSON.stringify(report, null, 2));
  const seedance = providers.seedance as
    | {
        peak: number;
        peakByOrganisation: Record<string, number>;
        cap: { max: number; perOrganisation: number } | null;
      }
    | undefined;
  const md = renderMarkdown({
    title: `${scenario} (${summary.projects} videos, ${tier}, time scale ${timeScale})`,
    timeScale,
    summary,
    extra: {
      'Seedance peak in flight / cap': `${seedance?.peak ?? 0} / ${seedance?.cap?.max ?? 'none'}`,
      'Seedance peak per organisation / share': `${Math.max(0, ...Object.values(seedance?.peakByOrganisation ?? {}))} / ${seedance?.cap?.perOrganisation ?? 'none'}`,
      'Simulated 429s answered': Object.values(providers).reduce((n, p) => n + p.rateLimited, 0),
      'Job runs deferred (no attempt spent)': deferred,
      'Projects that showed "queued, starting soon"': waited,
      'Worker peak RSS / heap': `${resources.peakRssMb} MB / ${resources.peakHeapMb} MB`,
      'Worker peak CPU (one process)': `${resources.peakCpuPct}%`,
      'FFmpeg peak children / RSS': `${resources.peakFfmpeg} / ${resources.peakFfmpegRssMb} MB`,
      'Postgres peak connections (all clients)': resources.peakDbConnections,
      'Assets queue peak waiting + delayed': resources.peakAssetsWaiting,
    },
  });
  await writeFile(join(args.out ?? '.', `${scenario}.md`), md);
  out(md);

  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(watch.map((q) => q.close()));
  await queue.close();
  await local.close();
  await db.$disconnect();

  if (args.assert) {
    const problems = assertions(summary, providers, outcomes);
    if (problems.length) {
      out(`ASSERTIONS FAILED:\n- ${problems.join('\n- ')}`);
      process.exit(1);
    }
  }
  process.exit(0);
}

type ProviderReport = Record<
  string,
  {
    peak: number;
    peakByOrganisation: Record<string, number>;
    cap: { max: number; perOrganisation: number } | null;
  }
>;

/** What a healthy run must show (CI --assert). */
export function assertions(
  summary: ReturnType<typeof summarise>,
  providers: ProviderReport,
  outcomes: readonly ProjectOutcome[],
): string[] {
  const problems: string[] = [];
  for (const [id, p] of Object.entries(providers)) {
    if (!p.cap) continue;
    if (p.peak > p.cap.max) problems.push(`${id}: ${p.peak} in flight over the cap ${p.cap.max}`);
    const orgPeak = Math.max(0, ...Object.values(p.peakByOrganisation));
    if (orgPeak > p.cap.perOrganisation) {
      problems.push(
        `${id}: one organisation held ${orgPeak} slots over its share ${p.cap.perOrganisation}`,
      );
    }
  }
  const rateFailures = outcomes.filter((o) =>
    /rate_limited|rate_deferred/.test(o.errorReason ?? ''),
  );
  if (rateFailures.length) problems.push(`${rateFailures.length} projects failed on a rate limit`);
  // The cost guard pausing a heavy organisation at its daily cap is the guard working, not a
  // pipeline failure: those runs are left out of the "reached review" bar.
  const capped = outcomes.filter((o) => (o.errorReason ?? '').startsWith('cost_cap_paused')).length;
  const expected = summary.projects - capped;
  if (summary.ready < expected * 0.9) {
    problems.push(`only ${summary.ready}/${expected} projects reached review`);
  }
  if (!outcomes.every((o) => READY_STATES.includes(o.finalState) || TERMINAL.has(o.finalState))) {
    problems.push('some projects never finished');
  }
  return problems;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/load/pipeline-load.ts')) {
  main().catch((err: unknown) => {
    logger.error({ err }, 'load test failed');
    process.exit(1);
  });
}
