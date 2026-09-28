import { PrismaClient } from '@prisma/client';
import { UpstreamServiceError, ValidationError } from '../../../src/lib/errors';
import type { GateCommand } from '../../../src/lib/studio/ops/staging-gate/args';
import {
  buildKillSwitchPlans,
  levelSeconds,
  levelSection,
  levelVerdict,
  LOAD_WINDOW_MS,
  renderDeployCommand,
  rollbackSections,
  UNMEASURED_NOTE,
  waitForReady,
  type LevelOutcome,
  type RollbackPhase,
} from '../../../src/lib/studio/ops/staging-gate/rehearse';
import {
  combineVerdicts,
  redactUrl,
  type GateReport,
  type GateSection,
} from '../../../src/lib/studio/ops/staging-gate/report';
import {
  observeHalt,
  publishQueueActive,
  waitForDrain,
  type RehearsalPlan,
  type ScopeObservation,
} from '../../../src/lib/studio/ops/rehearsal';
import { baseContext, env, optionalEnv, out, runProcess, sleep } from './common';

// 14.6 — `staging-gate.ts --rehearse kill-switch|rollback|all` against STAGING.
//
// Kill switch env: STUDIO_URL, STUDIO_STAFF_TOKEN (platform staff JWT), METRICS_URL +
// METRICS_TOKEN (global drain), STAGING_DATABASE_URL (read-only role; times the scoped levels).
// Rollback env: STAGING_DEPLOY_CMD (with {tag}), ROLLBACK_FROM_TAG (N) / ROLLBACK_TO_TAG (N+1)
// or --from-tag/--to-tag, and STAGING_READY_URL (default STUDIO_URL/api/health/ready).
// Put staging under load first (k6 smoke + a few real generations + scheduled posts on the
// rehearsed platform) — runbooks/kill-switch.md.

type RehearseCommand = Extract<GateCommand, { kind: 'rehearse' }>;

async function setSwitch(plan: RehearsalPlan, enabled: boolean): Promise<void> {
  const res = await fetch(`${env('STUDIO_URL')}/api/studio/admin/kill-switch`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${env('STUDIO_STAFF_TOKEN')}`,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({ ...plan, enabled }),
  });
  if (!res.ok) {
    throw new UpstreamServiceError(`kill-switch PUT failed: ${res.status} ${await res.text()}`);
  }
}

async function scrapeMetrics(): Promise<string> {
  const res = await fetch(env('METRICS_URL'), {
    headers: { authorization: `Bearer ${env('METRICS_TOKEN')}` },
  });
  if (!res.ok) throw new UpstreamServiceError(`metrics scrape failed: ${res.status}`);
  return res.text();
}

/** Read-only probes of in-scope work (see rehearsal.ts "scoped levels"). */
async function makeProbe(
  db: PrismaClient,
  plan: RehearsalPlan,
  engagedAt: Date,
): Promise<{ probe: () => Promise<ScopeObservation>; activityBefore: number }> {
  const target = plan.target ?? '';
  const windowStart = new Date(engagedAt.getTime() - LOAD_WINDOW_MS);
  if (plan.level === 'platform') {
    const activityBefore = await db.videoPublication.count({
      where: {
        platform: target,
        state: { in: ['PUBLISHING', 'PUBLISHED'] },
        updatedAt: { gt: windowStart, lte: engagedAt },
      },
    });
    const inFlightAtEngage = new Set(
      (
        await db.videoPublication.findMany({
          where: { platform: target, state: 'PUBLISHING' },
          select: { id: true },
        })
      ).map((p) => p.id),
    );
    const probe = async (): Promise<ScopeObservation> => {
      const [moved, inFlight] = await Promise.all([
        db.videoPublication.findMany({
          where: {
            platform: target,
            state: { in: ['PUBLISHING', 'PUBLISHED'] },
            updatedAt: { gt: engagedAt },
          },
          select: { id: true, updatedAt: true },
        }),
        db.videoPublication.count({ where: { platform: target, state: 'PUBLISHING' } }),
      ]);
      const started = moved.filter((p) => !inFlightAtEngage.has(p.id));
      const last = started.reduce<number | null>(
        (max, p) => Math.max(max ?? 0, p.updatedAt.getTime()),
        null,
      );
      let queueActive: number | undefined;
      if (optionalEnv('METRICS_URL') && optionalEnv('METRICS_TOKEN')) {
        queueActive = publishQueueActive(await scrapeMetrics());
      }
      return {
        startedSinceEngage: started.length,
        lastStartedAt: last,
        inFlight,
        ...(queueActive !== undefined && { publishQueueActive: queueActive }),
      };
    };
    return { probe, activityBefore };
  }
  const scope =
    plan.level === 'workspace'
      ? { organisationId: target }
      : plan.level === 'project'
        ? { projectId: target }
        : { provider: target };
  const activityBefore = await db.providerJob.count({
    where: { ...scope, startedAt: { gt: windowStart, lte: engagedAt } },
  });
  const probe = async (): Promise<ScopeObservation> => {
    const [started, inFlight] = await Promise.all([
      db.providerJob.aggregate({
        where: { ...scope, startedAt: { gt: engagedAt } },
        _count: { _all: true },
        _max: { startedAt: true },
      }),
      db.providerJob.count({ where: { ...scope, state: { in: ['PENDING', 'RUNNING'] } } }),
    ]);
    return {
      startedSinceEngage: started._count._all,
      lastStartedAt: started._max.startedAt?.getTime() ?? null,
      inFlight,
    };
  };
  return { probe, activityBefore };
}

async function rehearseLevel(
  plan: RehearsalPlan,
  db: PrismaClient | undefined,
  observeMs: number,
): Promise<LevelOutcome> {
  out(`\n→ ${plan.level}${plan.target ? ` ${plan.target}` : ''}: engaging…`);
  const engagedAt = new Date();
  // Build the platform probe's "in flight at engage" set before engaging.
  const scoped = db && plan.level !== 'global' ? await makeProbe(db, plan, engagedAt) : undefined;
  try {
    await setSwitch(plan, true);
  } catch (err) {
    return { plan, kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  try {
    if (plan.level === 'global') {
      const result = await waitForDrain(
        { scrape: scrapeMetrics, now: Date.now, sleep },
        { startedAt: engagedAt.getTime() },
      );
      return { plan, kind: 'drain', result };
    }
    if (!scoped) {
      await sleep(30_000);
      return { plan, kind: 'unmeasured', note: UNMEASURED_NOTE(plan.level) };
    }
    const result = await observeHalt(
      { probe: scoped.probe, now: Date.now, sleep },
      { startedAt: engagedAt.getTime(), observeMs, requireIdle: plan.level === 'platform' },
    );
    return { plan, kind: 'halt', result, activityBefore: scoped.activityBefore };
  } catch (err) {
    return { plan, kind: 'error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    await setSwitch(plan, false);
    out(`  released ${plan.level}`);
  }
}

async function killSwitchSections(cmd: RehearseCommand): Promise<{
  sections: GateSection[];
  table: Array<{ level: string; seconds: string; verdict: string }>;
}> {
  const { plans, skipped } = buildKillSwitchPlans(cmd.levels, cmd.targets, process.env);
  const dbUrl = optionalEnv('STAGING_DATABASE_URL');
  const db = dbUrl ? new PrismaClient({ datasourceUrl: dbUrl }) : undefined;
  const sections: GateSection[] = [];
  const table: Array<{ level: string; seconds: string; verdict: string }> = [];
  try {
    for (const plan of plans) {
      const outcome = await rehearseLevel(plan, db, cmd.observeSeconds * 1000);
      sections.push(levelSection(outcome));
      table.push({
        level: `${plan.level}${plan.target ? ` ${plan.target}` : ''}`,
        seconds: levelSeconds(outcome),
        verdict: levelVerdict(outcome),
      });
      out(`  ${levelVerdict(outcome)} (${levelSeconds(outcome)}s)`);
    }
  } finally {
    await db?.$disconnect();
  }
  for (const s of skipped) {
    sections.push({ title: `Kill switch — ${s.level}`, verdict: 'INCOMPLETE', lines: [s.reason] });
    table.push({ level: s.level, seconds: '—', verdict: 'INCOMPLETE' });
  }
  sections.unshift({
    title: 'Kill switch summary (SLO 60 s per level)',
    lines: [
      '| Level | Time (s) | Result |',
      '| --- | --- | --- |',
      ...table.map((r) => `| ${r.level} | ${r.seconds} | ${r.verdict} |`),
    ],
  });
  return { sections, table };
}

async function readyStatus(url: string): Promise<number> {
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    return res.status;
  } catch {
    return 0;
  }
}

async function deployAndWait(tag: string, readyUrl: string): Promise<RollbackPhase> {
  const command = renderDeployCommand(process.env.STAGING_DEPLOY_CMD, tag);
  out(`\n→ deploying ${tag}`);
  const startedAt = Date.now();
  const deploy = await runProcess(command, [], { shell: true });
  const ready = await waitForReady(
    { probe: () => readyStatus(readyUrl), now: Date.now, sleep },
    { startedAt },
  );
  return { tag, deployExitCode: deploy.exitCode, deployMs: deploy.durationMs, ready };
}

async function rollbackRun(
  cmd: RehearseCommand,
): Promise<{ sections: GateSection[]; secs: string }> {
  const fromTag = cmd.fromTag ?? optionalEnv('ROLLBACK_FROM_TAG');
  const toTag = cmd.toTag ?? optionalEnv('ROLLBACK_TO_TAG');
  if (!fromTag || !toTag) {
    throw new ValidationError('rollback needs --from-tag N and --to-tag N+1 (or ROLLBACK_*_TAG)');
  }
  const readyUrl = optionalEnv('STAGING_READY_URL') ?? `${env('STUDIO_URL')}/api/health/ready`;
  const forward = await deployAndWait(toTag, readyUrl);
  const forwardOk = forward.deployExitCode === 0 && forward.ready.ready;
  const rollback = forwardOk ? await deployAndWait(fromTag, readyUrl) : undefined;
  const r = rollbackSections({ fromTag, toTag, forward, rollback });
  return { sections: r.sections, secs: r.rollbackSeconds };
}

export async function runRehearse(cmd: RehearseCommand): Promise<GateReport> {
  const startedAt = new Date().toISOString();
  const sections: GateSection[] = [];
  const target = optionalEnv('STUDIO_URL') ?? optionalEnv('STAGING_READY_URL');
  const context: Record<string, string> = {
    ...baseContext(cmd.operator),
    ...(target && { Target: redactUrl(target) }),
  };
  if (cmd.what !== 'rollback') {
    const ks = await killSwitchSections(cmd);
    sections.push(...ks.sections);
  }
  if (cmd.what !== 'kill-switch') {
    const rb = await rollbackRun(cmd);
    sections.push(...rb.sections);
    context['Rollback time (s)'] = rb.secs;
  }
  const verdict = combineVerdicts(sections.flatMap((s) => (s.verdict ? [s.verdict] : [])));
  return {
    check: `rehearse-${cmd.what}`,
    title: `Rehearsal: ${cmd.what} (14.6)`,
    verdict,
    startedAt,
    finishedAt: new Date().toISOString(),
    context,
    sections,
    data: { levels: cmd.levels, targets: cmd.targets, observeSeconds: cmd.observeSeconds },
  };
}
