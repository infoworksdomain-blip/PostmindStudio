// 25 polish — GET /projects/:id/preview for the calendar side panel (24.2,
// src/lib/studio/services/post-preview.ts), so a calendar post shows its poster instead of the
// panel's error state. Same shape as the real route: name, state, format, aspect ratio, caption
// and hashtags, networks and scheduled time, a live status, and the media — a made post shows its
// Studio-made showcase poster (demo/media.ts samplePoster, labelled SAMPLE), a post still being
// made shows its storyboard stills.
import type { LiveProjectEvent } from '@/lib/studio/live/events';
import { estimateLive, liveFormatOf, liveStageOf } from '@/lib/studio/live/eta';
import type { PostPreview, PreviewAspect } from '@/lib/studio/services/post-preview';
import type { PreviewMedia } from '@/lib/studio/services/post-preview-media';
import { sceneImage } from '../../media';
import { route } from '../registry';
import { renderPoster } from './p15-a-publishing';
import { getProject, type ProjectRec } from './projects-store';
import { publicationsForProject } from './publications-store';

/** How long the poster is shown when the render has no length. */
const POSTER_SEC = 5;
/** services/post-preview.ts PREVIEW_ASPECTS (not imported: that module reads the database). */
const ASPECTS: readonly PreviewAspect[] = ['9:16', '1:1', '4:5', '16:9'];

function previewAspect(...candidates: Array<string | undefined>): PreviewAspect {
  for (const c of candidates) {
    const known = ASPECTS.find((a) => a === c);
    if (known) return known;
  }
  return '9:16';
}

function previewMediaOf(project: ProjectRec): PreviewMedia {
  const render = project.renders[0];
  if (render)
    return {
      kind: 'slides',
      rendered: true,
      slides: [
        {
          imageUrl: renderPoster(project),
          text: null,
          durationSec: render.durationSec || POSTER_SEC,
        },
      ],
    };
  const shots = project.scripts[0]?.shots ?? [];
  if (shots.length === 0) return { kind: 'none' };
  return {
    kind: 'storyboard',
    shots: shots.map((shot) => ({
      id: shot.id,
      sortOrder: shot.sortOrder,
      durationSec: shot.durationSec,
      text: shot.onScreenText,
      stillUrl: sceneImage(shot.kind, 360, 640),
      state: shot.state,
    })),
  };
}

export function demoPostPreview(projectId: string, nowMs = Date.now()): PostPreview {
  const project = getProject(projectId);
  const publications = publicationsForProject(project.id).filter((p) => p.state !== 'CANCELLED');
  const format = liveFormatOf(project);
  const stage = liveStageOf(project.state);
  const media = previewMediaOf(project);
  const live: LiveProjectEvent = {
    projectId: project.id,
    state: project.state,
    stage,
    format,
    ...estimateLive({ stage, format, startedAtMs: null, nowMs }),
    startedAt: null,
    thumbnailUrl: project.renders.length ? renderPoster(project) : null,
    at: new Date(nowMs).toISOString(),
  };
  const first = publications[0];
  const upcoming = publications.find(
    (p) => p.scheduledFor && (p.state === 'SCHEDULED' || p.state === 'PUBLISHING'),
  );
  const platforms = publications.length
    ? [...new Set(publications.map((p) => p.platform))]
    : [...new Set(project.targetFormats.map((f) => f.platform))];
  return {
    projectId: project.id,
    name: project.name,
    state: project.state,
    format,
    aspectRatio: previewAspect(
      project.renders[0]?.aspectRatio,
      project.targetFormats[0]?.aspectRatio,
    ),
    caption: first?.caption ?? project.brief?.hook ?? null,
    hashtags: first?.hashtags ?? [],
    platforms,
    publications: publications.map((p) => ({
      id: p.id,
      platform: p.platform,
      state: p.state,
      scheduledFor: p.scheduledFor,
      publishedAt: p.publishedAt,
      platformUrl: p.platformUrl,
    })),
    scheduledFor: upcoming?.scheduledFor ?? null,
    live,
    media,
  };
}

route('GET', '/projects/:id/preview', ({ params }) => ({
  preview: demoPostPreview(params.id ?? ''),
}));
