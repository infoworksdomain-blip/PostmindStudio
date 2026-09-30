// Phase 20.3 sample state — "plan a month ahead". The seeded "3 a week" drip queue (and the
// month-ahead view) live in p15-a-publishing.ts; this file adds a video that was approved as
// "next free slot" while no posting time was free, so its Review screen shows the notice
// (metadata.scheduleIssue, like automation/outbox.ts writes) and "Try again" schedules it into
// the queue's next free slot (POST /projects/:id/auto-publish/retry, p13-a3-admin.ts).
import { CONNECTIONS, DEMO_USER_ID, P20_PROJECTS } from '../ids';
import { demoNextFreeSlot } from './p15-a-publishing';
import type { ProjectContent, ShotContent } from './projects-content';
import {
  ago,
  baseProject,
  buildRender,
  buildScripts,
  DAY,
  fmt,
  HOUR,
  nowIso,
  putProject,
  type ProjectRec,
} from './projects-store';
import { addPublication } from './publications-store';

const shot = (
  kind: ShotContent['kind'],
  durationSec: number,
  scene: string,
  voiceover: string | null,
  onScreen: string | null,
): ShotContent => ({
  treatment: 'AI_CLIP',
  durationSec,
  kind,
  scene,
  camera: null,
  voiceover,
  onScreen,
});

const HARVEST: ProjectContent = {
  scene: 'sourdough',
  brief: {
    hook: 'Autumn’s first harvest loaf.',
    keyMessage: 'Spelt, pumpkin seeds and a long cold prove, every Friday in October.',
    targetAudience: 'Weekend regulars in north Leeds',
    tone: 'Warm, seasonal',
  },
  shots: [
    shot(
      'sourdough',
      4,
      'A seeded harvest loaf on a floured board.',
      'Harvest loaf is back.',
      'HARVEST LOAF',
    ),
    shot(
      'baker',
      5,
      'Hands folding pumpkin seeds into spelt dough.',
      'Spelt, seeds, patience.',
      null,
    ),
    shot('logo', 3, 'End card.', 'Fridays in October.', 'Fridays in October'),
  ],
};

function harvestLoaf(): ProjectRec {
  const { id, name } = P20_PROJECTS.harvestLoaf;
  const approvedAt = ago(DAY);
  const p = baseProject(id, name, {
    state: 'APPROVED',
    scene: HARVEST.scene,
    brief: HARVEST.brief,
    description: HARVEST.brief?.keyMessage ?? null,
    targetFormats: [fmt('tiktok', '9:16', 12)],
    costActualPence: 138,
    publishPolicy: 'SCHEDULED',
    createdAt: ago(2 * DAY),
    updatedAt: approvedAt,
    completedAt: approvedAt,
    approvals: [
      {
        id: 'apr-harvest',
        state: 'APPROVED',
        note: null,
        createdAt: approvedAt,
        resolvedByUserId: DEMO_USER_ID,
      },
    ],
    metadata: {
      autoPublish: {
        targets: [
          {
            platform: 'tiktok',
            connectionId: CONNECTIONS.tiktok.id,
            caption: 'Harvest loaf: Fridays in October.',
            hashtags: ['autumnbaking', 'leeds'],
          },
        ],
      },
      scheduleIssue: { reason: 'no_free_slot', horizonDays: 56, at: approvedAt },
    },
  });
  p.scripts = buildScripts(id, p.targetFormats, HARVEST);
  p.renders = p.scripts.map((s) =>
    buildRender(p, s, { id: `rnd-harvest-${s.targetPlatform}`, createdAt: ago(DAY + HOUR) }),
  );
  return p;
}

putProject(harvestLoaf());

/**
 * The retry for a project with a schedule notice: the next free slot of its business's queue, or
 * why there is none. null = not such a project (the retry handler goes on with failed rows).
 */
export function demoRetrySchedule(
  p: ProjectRec,
): { scheduled: number; unscheduled: string | null } | null {
  const issue = (p.metadata?.scheduleIssue ?? null) as { reason?: string } | null;
  if (p.publishPolicy !== 'SCHEDULED' || p.state !== 'APPROVED' || !issue) return null;
  const slot = demoNextFreeSlot(p.businessId);
  if (!slot) return { scheduled: 0, unscheduled: 'queue_off' };
  const render = p.renders[0];
  const { scheduleIssue: _cleared, ...rest } = p.metadata ?? {};
  void _cleared;
  p.metadata = rest;
  addPublication({
    id: `pub-${p.id}-scheduled`,
    projectId: p.id,
    renderId: render?.id ?? `rnd-${p.id}`,
    platform: render?.targetPlatform ?? 'tiktok',
    platformAccountId: CONNECTIONS.tiktok.accountId,
    state: 'SCHEDULED',
    scheduledFor: slot,
    publishedAt: null,
    platformPostId: null,
    platformUrl: null,
    caption: 'Harvest loaf: Fridays in October.',
    hashtags: ['autumnbaking', 'leeds'],
    errorReason: null,
    errorCode: null,
    retryCount: 0,
    createdAt: nowIso(),
    project: { id: p.id, name: p.name },
  });
  return { scheduled: 1, unscheduled: null };
}
