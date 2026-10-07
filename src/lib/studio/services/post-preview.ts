import type { PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../errors';
import { projectCopy } from '../hashtags/pool';
import { estimateLive, liveFormatOf, liveStageOf, type LiveFormat } from '../live/eta';
import type { LiveProjectEvent } from '../live/events';
import { liveSnapshot } from '../live/snapshot';
import type { AssetStorage } from '../storage';
import type { Platform } from './catalog';
import { previewMedia, type PreviewMedia } from './post-preview-media';

// BACKLOG 24.2 — GET /api/studio/projects/:id/preview: everything the calendar side panel shows
// for one post in one request: the instant preview (post-preview-media.ts), the caption and
// hashtags, the networks and times it is scheduled for, and its live status. Read-only; the
// panel's actions call the existing routes (approve, generate, PATCH /publications/:id).

export const PREVIEW_ASPECTS = ['9:16', '1:1', '4:5', '16:9'] as const;
export type PreviewAspect = (typeof PREVIEW_ASPECTS)[number];

export interface PreviewPublication {
  id: string;
  platform: string;
  state: string;
  scheduledFor: string | null;
  publishedAt: string | null;
  platformUrl: string | null;
}

export interface PostPreview {
  projectId: string;
  name: string | null;
  state: string;
  format: LiveFormat | null;
  aspectRatio: PreviewAspect;
  caption: string | null;
  hashtags: string[];
  /** Networks the post goes to (its publications', else its target formats'). */
  platforms: string[];
  publications: PreviewPublication[];
  /** The earliest scheduled time of a publication still to go out. */
  scheduledFor: string | null;
  live: LiveProjectEvent;
  media: PreviewMedia;
}

export interface PreviewDeps {
  db: PrismaClient;
  storage: AssetStorage;
  now: () => number;
}

/** A known aspect ratio, else portrait (every short-form network's default). */
export function previewAspect(...candidates: Array<string | null | undefined>): PreviewAspect {
  for (const c of candidates)
    if (c && (PREVIEW_ASPECTS as readonly string[]).includes(c)) return c as PreviewAspect;
  return '9:16';
}

function targets(value: unknown): Array<{ platform?: string; aspectRatio?: string }> {
  return Array.isArray(value)
    ? value.filter(
        (v): v is { platform?: string; aspectRatio?: string } =>
          v !== null && typeof v === 'object',
      )
    : [];
}

export async function getPostPreview(
  deps: PreviewDeps,
  organisationId: string,
  projectId: string,
): Promise<PostPreview> {
  const project = await deps.db.videoProject.findFirst({
    where: { id: projectId, organisationId, deletedAt: null },
    select: {
      id: true,
      organisationId: true,
      name: true,
      state: true,
      sourceType: true,
      metadata: true,
      targetFormats: true,
      publications: {
        where: { state: { notIn: ['CANCELLED'] } },
        orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          platform: true,
          state: true,
          scheduledFor: true,
          publishedAt: true,
          platformUrl: true,
          caption: true,
          hashtags: true,
        },
      },
    },
  });
  if (!project) throw new NotFoundError('Project not found');
  const format = liveFormatOf(project);
  const formats = targets(project.targetFormats);
  const [{ media, renderAspect }, live] = await Promise.all([
    previewMedia(deps, project, format),
    liveSnapshot(deps, organisationId, project.id),
  ]);
  const copy = projectCopy(project.metadata);
  const firstPub = project.publications[0];
  const platform = firstPub?.platform ?? formats[0]?.platform;
  const stored =
    (platform && (copy.owner[platform as Platform] ?? copy.generated[platform as Platform])) ||
    Object.values(copy.owner)[0] ||
    Object.values(copy.generated)[0];
  const upcoming = project.publications.find(
    (p) => p.scheduledFor && (p.state === 'SCHEDULED' || p.state === 'PUBLISHING'),
  );
  const platforms = project.publications.length
    ? [...new Set(project.publications.map((p) => p.platform))]
    : [...new Set(formats.map((f) => f.platform).filter((p): p is string => !!p))];
  return {
    projectId: project.id,
    name: project.name,
    state: project.state,
    format,
    aspectRatio: previewAspect(renderAspect, formats[0]?.aspectRatio),
    caption: firstPub?.caption ?? stored?.caption ?? null,
    hashtags: firstPub?.hashtags.length ? firstPub.hashtags : (stored?.hashtags ?? []),
    platforms,
    publications: project.publications.map((p) => ({
      id: p.id,
      platform: p.platform,
      state: p.state,
      scheduledFor: p.scheduledFor?.toISOString() ?? null,
      publishedAt: p.publishedAt?.toISOString() ?? null,
      platformUrl: p.platformUrl,
    })),
    scheduledFor: upcoming?.scheduledFor?.toISOString() ?? null,
    live: live ?? fallbackLive(project, format, deps.now()),
    media,
  };
}

function fallbackLive(
  project: { id: string; state: string },
  format: LiveFormat | null,
  nowMs: number,
): LiveProjectEvent {
  const stage = liveStageOf(project.state);
  return {
    projectId: project.id,
    state: project.state,
    stage,
    format,
    ...estimateLive({ stage, format, startedAtMs: null, nowMs }),
    startedAt: null,
    thumbnailUrl: null,
    at: new Date(nowMs).toISOString(),
  };
}
