import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import {
  PLAN_CATALOGUE,
  TYPICAL_COST_PENCE_PER_VIDEO,
} from '../../src/lib/studio/billing/catalogue';
import { fakeProvidersRequested } from '../../src/lib/studio/load-test/guard';
import { createBullJobQueue, jobIds } from '../../src/lib/studio/queue/enqueue';
import { redisConnectionFromEnv } from '../../src/lib/studio/queue/redis';
import type { PlanTier } from '../../src/lib/studio/providers/router';

// BACKLOG 20.29 Phase 2 — a SMALL burst with REAL providers on the live server, to confirm the
// simulated numbers (runbooks/load-testing.md). SPENDS MONEY: run it only after the operator has
// approved the cost. It starts N 30-second videos at once for one organisation the operator owns
// (the running worker does the work), then polls until they finish and prints time-to-ready, the
// providers used and the cost of each. It refuses to start unless --confirm-spend-pence covers N
// × the per-video budget (the hard cap per project), so the spend can never exceed what was approved.
//
//   scripts/vps/compose.sh production run --rm ops node --import tsx scripts/load/real-burst.ts \
//     --org <organisationId> --business <businessId> --videos 5 --confirm-spend-pence 2000

export const PER_VIDEO_BUDGET_PENCE = 400;

/** The most the burst may spend: every project is capped at PER_VIDEO_BUDGET_PENCE. */
export function maxSpendPence(videos: number): number {
  return videos * PER_VIDEO_BUDGET_PENCE;
}

export function checkBurstArgs(input: {
  org?: string;
  business?: string;
  videos: number;
  confirmSpendPence: number;
  fakeProviders: boolean;
}): string[] {
  const problems: string[] = [];
  if (input.fakeProviders)
    problems.push('STUDIO_FAKE_PROVIDERS is set: this is the real-provider check');
  if (!input.org) problems.push('--org is required');
  if (!input.business) problems.push('--business is required');
  if (!Number.isInteger(input.videos) || input.videos < 1 || input.videos > 10) {
    problems.push('--videos must be 1–10');
  }
  if (!(input.confirmSpendPence >= maxSpendPence(input.videos))) {
    problems.push(
      `--confirm-spend-pence must be at least ${maxSpendPence(input.videos)} (videos × ${PER_VIDEO_BUDGET_PENCE}p cap)`,
    );
  }
  return problems;
}

const TERMINAL = new Set(['READY_FOR_REVIEW', 'QUALITY_FAILED', 'FAILED', 'REJECTED', 'APPROVED']);
const out = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      org: { type: 'string' },
      business: { type: 'string' },
      videos: { type: 'string', default: '5' },
      'confirm-spend-pence': { type: 'string', default: '0' },
      'timeout-min': { type: 'string', default: '90' },
    },
  });
  const videos = Number(args.videos);
  const problems = checkBurstArgs({
    org: args.org,
    business: args.business,
    videos,
    confirmSpendPence: Number(args['confirm-spend-pence']),
    fakeProviders: fakeProvidersRequested(process.env),
  });
  if (problems.length) throw new Error(problems.join('; '));
  const db = new PrismaClient();
  const entitlement = await db.orgEntitlement.findUnique({
    where: { organisationId: args.org ?? '' },
  });
  if (!entitlement || entitlement.access !== 'full') {
    throw new Error('the organisation needs full access (a plan) to generate');
  }
  const tier = entitlement.tier as PlanTier;
  const typical = tier === 'ENTERPRISE' ? undefined : TYPICAL_COST_PENCE_PER_VIDEO[tier].short;
  out(
    `${videos} × 30 s ${tier} shorts; typical ${typical ?? '?'}p each, capped at ${PER_VIDEO_BUDGET_PENCE}p (queue priority ${PLAN_CATALOGUE[tier].queuePriority})`,
  );
  const queue = createBullJobQueue(redisConnectionFromEnv());
  const started = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < videos; i += 1) {
    const runId = randomUUID();
    const project = await db.videoProject.create({
      data: {
        organisationId: args.org ?? '',
        businessId: args.business ?? '',
        createdByUserId: 'load-test-phase-2',
        name: `Load test (real providers) ${i + 1}/${videos}`,
        description:
          'A 30-second TikTok for our business: what we do, why customers love it, and a clear call to action.',
        state: 'QUEUED',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 30 }],
        costBudgetPence: PER_VIDEO_BUDGET_PENCE,
        metadata: { runId, loadTest: 'phase-2' },
      },
    });
    const job = { projectId: project.id, organisationId: args.org ?? '', runId, planTier: tier };
    await queue.add('plan-project', job, { jobId: jobIds.planProject(job) });
    ids.push(project.id);
  }
  out(`started ${ids.join(', ')}`);
  const finished = new Map<string, number>();
  const deadline = started + Number(args['timeout-min']) * 60_000;
  while (finished.size < ids.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000));
    for (const p of await db.videoProject.findMany({ where: { id: { in: ids } } })) {
      if (TERMINAL.has(p.state) && !finished.has(p.id)) {
        finished.set(p.id, Date.now());
        out(
          `${p.id} ${p.state} after ${Math.round((Date.now() - started) / 1000)} s, ${p.costActualPence}p`,
        );
      }
    }
  }
  const jobs = await db.providerJob.groupBy({
    by: ['provider', 'state'],
    where: { projectId: { in: ids } },
    _count: { _all: true },
    _sum: { costPence: true },
  });
  for (const j of jobs) {
    out(`${j.provider} ${j.state}: ${j._count._all} jobs, ${j._sum.costPence ?? 0}p`);
  }
  await queue.close();
  await db.$disconnect();
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/load/real-burst.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
