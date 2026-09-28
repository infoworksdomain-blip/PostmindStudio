import type { PrismaClient, VideoProjectState } from '@prisma/client';
import { z } from 'zod';
import { plusActive } from './beta';
import { viewFeedback } from './feedback';

// BACKLOG 14.11 — staff beta dashboard (Admin → Beta): for every organisation in a beta cohort,
// over the last `days` days: videos generated (projects that reached review or beyond), videos
// published, the failure rate (FAILED + QUALITY_FAILED over finished runs), provider cost
// (provider_usage) and feedback, plus the most recent feedback across the cohort.

export const betaDashboardQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  cohort: z.string().trim().min(1).max(64).optional(),
});

export type BetaDashboardQuery = z.infer<typeof betaDashboardQuery>;

/** A run that produced a video (whatever happened to it afterwards). */
export const GENERATED_STATES: VideoProjectState[] = [
  'READY_FOR_REVIEW',
  'APPROVED',
  'PUBLISHING',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
  'REJECTED',
];
export const FAILED_STATES: VideoProjectState[] = ['FAILED', 'QUALITY_FAILED'];
const RECENT_FEEDBACK = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BetaOrgRow {
  organisationId: string;
  cohort: string;
  plusUntil: string | null;
  plusActive: boolean;
  enrolledAt: string;
  videosGenerated: number;
  videosFailed: number;
  videosPublished: number;
  /** failed / (generated + failed); null when nothing finished yet. */
  failureRate: number | null;
  costPence: number;
  feedbackCount: number;
}

export function failureRate(generated: number, failed: number): number | null {
  const finished = generated + failed;
  return finished === 0 ? null : Math.round((failed / finished) * 1000) / 1000;
}

type DashboardDb = Pick<
  PrismaClient,
  'organisationBeta' | 'videoProject' | 'videoPublication' | 'providerUsage' | 'betaFeedback'
>;

export async function betaDashboard(db: DashboardDb, query: BetaDashboardQuery, now: number) {
  const since = new Date(now - query.days * DAY_MS);
  const members = await db.organisationBeta.findMany({
    where: query.cohort ? { cohort: query.cohort } : {},
    orderBy: [{ cohort: 'asc' }, { enrolledAt: 'asc' }],
  });
  const orgIds = members.map((m) => m.organisationId);
  const inOrgs = { organisationId: { in: orgIds } };
  const [projects, published, cost, feedback, recent] = orgIds.length
    ? await Promise.all([
        db.videoProject.groupBy({
          by: ['organisationId', 'state'],
          where: { ...inOrgs, createdAt: { gte: since } },
          _count: { _all: true },
        }),
        db.videoPublication.groupBy({
          by: ['organisationId'],
          where: { ...inOrgs, state: 'PUBLISHED', publishedAt: { gte: since } },
          _count: { _all: true },
        }),
        db.providerUsage.groupBy({
          by: ['organisationId'],
          where: { ...inOrgs, day: { gte: since } },
          _sum: { costPence: true },
        }),
        db.betaFeedback.groupBy({
          by: ['organisationId'],
          where: { ...inOrgs, createdAt: { gte: since } },
          _count: { _all: true },
        }),
        db.betaFeedback.findMany({
          where: { ...inOrgs, createdAt: { gte: since } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: RECENT_FEEDBACK,
        }),
      ])
    : [[], [], [], [], []];

  const count = (orgId: string, states: VideoProjectState[]) =>
    projects
      .filter((p) => p.organisationId === orgId && states.includes(p.state))
      .reduce((sum, p) => sum + p._count._all, 0);

  const organisations: BetaOrgRow[] = members.map((m) => {
    const generated = count(m.organisationId, GENERATED_STATES);
    const failed = count(m.organisationId, FAILED_STATES);
    return {
      organisationId: m.organisationId,
      cohort: m.cohort,
      plusUntil: m.plusUntil?.toISOString() ?? null,
      plusActive: plusActive(m, now),
      enrolledAt: m.enrolledAt.toISOString(),
      videosGenerated: generated,
      videosFailed: failed,
      videosPublished:
        published.find((p) => p.organisationId === m.organisationId)?._count._all ?? 0,
      failureRate: failureRate(generated, failed),
      costPence: cost.find((c) => c.organisationId === m.organisationId)?._sum.costPence ?? 0,
      feedbackCount: feedback.find((f) => f.organisationId === m.organisationId)?._count._all ?? 0,
    };
  });

  const totals = organisations.reduce(
    (t, o) => ({
      organisations: t.organisations + 1,
      videosGenerated: t.videosGenerated + o.videosGenerated,
      videosFailed: t.videosFailed + o.videosFailed,
      videosPublished: t.videosPublished + o.videosPublished,
      costPence: t.costPence + o.costPence,
      feedbackCount: t.feedbackCount + o.feedbackCount,
    }),
    {
      organisations: 0,
      videosGenerated: 0,
      videosFailed: 0,
      videosPublished: 0,
      costPence: 0,
      feedbackCount: 0,
    },
  );

  return {
    days: query.days,
    since: since.toISOString(),
    cohorts: [...new Set(members.map((m) => m.cohort))],
    totals: { ...totals, failureRate: failureRate(totals.videosGenerated, totals.videosFailed) },
    organisations,
    recentFeedback: recent.map(viewFeedback),
  };
}
