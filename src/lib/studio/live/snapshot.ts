import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AssetStorage } from '../storage';
import { estimateLive, IN_PROGRESS_STAGES, liveFormatOf, liveStageOf } from './eta';
import type { LiveProjectEvent } from './events';

// BACKLOG 24.2 — a project's live status, read from the database and ALWAYS scoped to the
// caller's organisation (the SSE route and GET /live/projects/status both pass the signed-in
// member's organisation; another organisation's project id simply finds nothing).

export const THUMBNAIL_TTL_SEC = 60 * 60;
export const MAX_STATUS_IDS = 100;

export const statusQuery = z.object({
  ids: z
    .string()
    .trim()
    .min(1)
    .transform((v) => [...new Set(v.split(',').map((id) => id.trim()))].filter(Boolean))
    .pipe(z.array(z.string().min(1).max(128)).min(1).max(MAX_STATUS_IDS)),
});

export interface SnapshotDeps {
  db: Pick<PrismaClient, 'videoProject' | 'videoRender'>;
  storage: Pick<AssetStorage, 'signedUrl'>;
  now: () => number;
}

function startedAtOf(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const start = (metadata as { generationStart?: { at?: unknown } }).generationStart;
  return typeof start?.at === 'string' && !Number.isNaN(Date.parse(start.at)) ? start.at : null;
}

async function thumbnailFor(deps: SnapshotDeps, projectId: string): Promise<string | null> {
  const render = await deps.db.videoRender.findFirst({
    where: { projectId, thumbnailS3Key: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { s3Bucket: true, thumbnailS3Key: true },
  });
  if (!render?.thumbnailS3Key) return null;
  return deps.storage.signedUrl(render.s3Bucket, render.thumbnailS3Key, THUMBNAIL_TTL_SEC);
}

/** Live status of the organisation's projects among `ids` (unknown / foreign ids are absent). */
export async function liveSnapshots(
  deps: SnapshotDeps,
  organisationId: string,
  ids: readonly string[],
): Promise<LiveProjectEvent[]> {
  if (ids.length === 0) return [];
  const projects = await deps.db.videoProject.findMany({
    where: { id: { in: [...ids] }, organisationId, deletedAt: null },
    select: { id: true, state: true, sourceType: true, metadata: true },
  });
  const nowMs = deps.now();
  return Promise.all(
    projects.map(async (project): Promise<LiveProjectEvent> => {
      const stage = liveStageOf(project.state);
      const format = liveFormatOf(project);
      const startedAt = startedAtOf(project.metadata);
      const estimate = estimateLive({
        stage,
        format,
        startedAtMs: startedAt ? Date.parse(startedAt) : null,
        nowMs,
      });
      const made = stage !== null && !IN_PROGRESS_STAGES.has(stage) && stage !== 'failed';
      return {
        projectId: project.id,
        state: project.state,
        stage,
        format,
        ...estimate,
        startedAt,
        thumbnailUrl: made ? await thumbnailFor(deps, project.id) : null,
        at: new Date(nowMs).toISOString(),
      };
    }),
  );
}

export async function liveSnapshot(
  deps: SnapshotDeps,
  organisationId: string,
  projectId: string,
): Promise<LiveProjectEvent | null> {
  const [event] = await liveSnapshots(deps, organisationId, [projectId]);
  return event ?? null;
}
