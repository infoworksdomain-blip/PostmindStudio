import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { MetricSnapshot } from '../analytics/store';
import { notifySafely, type Notifier } from './notifier';

// BACKLOG 13.23 / spec 14.4 "Milestone hit (10k views, 100 comments) — in-app; email opt-in".
// After every analytics poll the new cumulative totals are compared with the milestones; each
// (publication, milestone) notifies the project's creator exactly once — the notification's
// dedupeKey (unique per organisation) is the once-only guarantee, so a re-poll, a retry or two
// workers polling at once never notify twice. Email follows the user's notification preferences.

export interface Milestone {
  metric: 'views' | 'comments';
  threshold: number;
  label: string;
}

export const MILESTONES: readonly Milestone[] = [
  { metric: 'views', threshold: 10_000, label: '10,000 views' },
  { metric: 'comments', threshold: 100, label: '100 comments' },
];

export function reachedMilestones(snapshot: Pick<MetricSnapshot, 'views' | 'comments'>) {
  return MILESTONES.filter((m) => (snapshot[m.metric] ?? 0) >= m.threshold);
}

export const milestoneKey = (publicationId: string, m: Milestone) =>
  `milestone:${publicationId}:${m.metric}_${m.threshold}`;

type Host = { db: PrismaClient; logger: Logger; notifier?: Notifier };

const PLATFORM_NAME: Record<string, string> = {
  tiktok: 'TikTok',
  instagram_reel: 'Instagram',
  youtube_short: 'YouTube Shorts',
  youtube: 'YouTube',
  linkedin_video: 'LinkedIn',
  x: 'X',
  facebook: 'Facebook',
  instagram_feed: 'Instagram',
  facebook_feed: 'Facebook',
};

/** Never throws: a milestone that cannot be stored is logged, the poll carries on. */
export async function notifyMilestones(
  host: Host,
  publication: { id: string; organisationId: string; projectId: string; platform: string },
  snapshot: Pick<MetricSnapshot, 'views' | 'comments'>,
): Promise<number> {
  const reached = reachedMilestones(snapshot);
  if (reached.length === 0) return 0;
  try {
    const project = await host.db.videoProject.findFirst({
      where: { id: publication.projectId, organisationId: publication.organisationId },
      select: { name: true, createdByUserId: true },
    });
    if (!project) return 0;
    const where = PLATFORM_NAME[publication.platform] ?? publication.platform;
    for (const m of reached) {
      await notifySafely(host, {
        organisationId: publication.organisationId,
        userId: project.createdByUserId,
        kind: 'milestone',
        title: `“${project.name}” reached ${m.label} on ${where}`,
        body: `Now at ${snapshot[m.metric].toLocaleString('en-GB')} ${m.metric}. Open the project to see its publications and analytics.`,
        link: `/projects/${publication.projectId}`,
        dedupeKey: milestoneKey(publication.id, m),
      });
    }
    return reached.length;
  } catch (err) {
    host.logger.error({ err, publicationId: publication.id }, 'milestone check failed');
    return 0;
  }
}
