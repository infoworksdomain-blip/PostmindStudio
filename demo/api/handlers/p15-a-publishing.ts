// Phase 15 Track A — publishing and distribution sample handlers, with the same envelopes,
// validation messages and shapes as the real routes:
//   GET/PUT /businesses/:id/drip-queue            (15.A5, services/drip-queue.ts)
//   GET     /analytics/best-times                 (15.A6, analytics/best-times.ts)
//   POST    /projects/:id/caption-suggestions     (15.A7, services/caption-suggestions.ts)
//   GET     /renders/:id  (+ thumbnailUrl)         (15.A3)
//   POST    /renders/:id/thumbnail                 (15.A3, JSON regenerate or multipart upload)
//   GET     /renders/:id/captions                  (15.A4, burned-in vs SRT lines)
// Registered before ./review so GET /renders/:id carries the thumbnail URL.
import type { Publication } from '@/lib/client/types';
import { DemoHttpError, route } from '../registry';
import { findRender, getProject } from './projects-store';

const bad = (message: string) => new DemoHttpError(400, 'validation_error', message);
const DAY = 86_400_000;

// ------------------------------------------------------------------ drip queue (A5)

interface Slot {
  weekday: number;
  time: string;
  timezone: string;
}
const dripQueues = new Map<
  string,
  { slots: Slot[]; platforms: string[]; enabled: boolean; updatedAt: string }
>();

function nextSlot(slots: Slot[]): string | null {
  // Demo approximation of the real zoned calculation: next matching weekday at HH:MM UTC.
  const now = Date.now();
  let best: number | null = null;
  for (const s of slots) {
    const [h, m] = s.time.split(':').map(Number) as [number, number];
    for (let d = 0; d <= 7; d += 1) {
      const day = new Date(now + d * DAY);
      if (day.getUTCDay() !== s.weekday) continue;
      const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m);
      if (at > now + 120_000 && (best === null || at < best)) best = at;
    }
  }
  return best === null ? null : new Date(best).toISOString();
}

function view(q: { slots: Slot[]; platforms: string[]; enabled: boolean; updatedAt: string }) {
  return {
    slots: q.slots,
    platforms: q.platforms,
    enabled: q.enabled,
    staggerMinutes: 30,
    nextSlotAt: q.enabled ? nextSlot(q.slots) : null,
    queued: 0,
    upcoming: [],
    updatedAt: q.updatedAt,
  };
}

route('GET', '/businesses/:id/drip-queue', ({ params }) => {
  const q = dripQueues.get(params.id ?? '');
  return { dripQueue: q ? view(q) : null };
});

route('PUT', '/businesses/:id/drip-queue', ({ params, body }) => {
  const input = (body ?? {}) as { slots?: unknown; platforms?: unknown; enabled?: unknown };
  if (!Array.isArray(input.slots) || input.slots.length === 0 || input.slots.length > 28)
    throw bad('slots: between 1 and 28 slots');
  const slots = input.slots.map((raw, i) => {
    const s = raw as Partial<Slot>;
    if (!Number.isInteger(s.weekday) || (s.weekday ?? -1) < 0 || (s.weekday ?? 7) > 6)
      throw bad(`slots.${i}.weekday: 0-6`);
    if (typeof s.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time))
      throw bad(`slots.${i}.time: time must be HH:MM (24-hour)`);
    if (typeof s.timezone !== 'string' || !s.timezone)
      throw bad(`slots.${i}.timezone: timezone must be an IANA time zone`);
    return { weekday: s.weekday as number, time: s.time, timezone: s.timezone };
  });
  const q = {
    slots,
    platforms: Array.isArray(input.platforms) ? (input.platforms as string[]) : [],
    enabled: input.enabled !== false,
    updatedAt: new Date().toISOString(),
  };
  dripQueues.set(params.id ?? '', q);
  return { dripQueue: view(q) };
});

// ------------------------------------------------------------------ best times (A6)

route('GET', '/analytics/best-times', ({ query }) => {
  const platform = query.get('platform');
  return {
    data: [
      { weekday: 2, hour: 8, score: 1, basis: '6 videos' },
      { weekday: 4, hour: 18, score: 0.82, basis: '5 videos' },
      { weekday: 6, hour: 10, score: 0.64, basis: '3 videos' },
    ],
    bestPerDay: [
      { weekday: 2, hour: 8, score: 1, basis: '6 videos' },
      { weekday: 4, hour: 18, score: 0.82, basis: '5 videos' },
      { weekday: 6, hour: 10, score: 0.64, basis: '3 videos' },
    ],
    sufficientData: true,
    videos: 14,
    minVideos: 8,
    timezone: query.get('timezone') ?? 'UTC',
    platform: platform ?? null,
    styleMemory: null,
    advisory: true,
  };
});

// ------------------------------------------------------------------ caption suggestions (A7)

const CONVENTION: Record<string, { tags: string[]; suffix: string }> = {
  tiktok: { tags: ['sourdough', 'leeds', 'bakery'], suffix: '' },
  instagram_reel: {
    tags: ['sourdough', 'leedsfood', 'bakery', 'realbread', 'weekend'],
    suffix: '',
  },
  instagram_feed: { tags: ['sourdough', 'leedsfood', 'bakery', 'realbread'], suffix: '' },
  youtube_short: { tags: ['sourdough'], suffix: '' },
  youtube: {
    tags: ['sourdough', 'baking', 'leeds'],
    suffix: '\n\n0:00 The loaf\n0:08 How we bake it',
  },
  linkedin_video: { tags: ['smallbusiness', 'leeds', 'food'], suffix: '' },
  x: { tags: ['sourdough'], suffix: '' },
  facebook: { tags: [], suffix: '' },
  facebook_feed: { tags: [], suffix: '' },
};

route('POST', '/projects/:id/caption-suggestions', ({ params }) => {
  const project = getProject(params.id ?? '');
  const hook = project.brief?.hook ?? project.name ?? '';
  const platforms = [...new Set(project.renders.map((r) => r.targetPlatform))];
  const suggestions = Object.fromEntries(
    platforms.map((p) => {
      const c = CONVENTION[p] ?? { tags: [], suffix: '' };
      const caption = p === 'x' ? hook.slice(0, 200) : `${hook}${c.suffix}`;
      return [
        p,
        {
          caption,
          hashtags: c.tags,
          ...((p === 'youtube' || p === 'youtube_short') && { title: hook.slice(0, 100) }),
        },
      ];
    }),
  );
  return {
    suggestions,
    language: 'en-GB',
    generatedAt: new Date().toISOString(),
    cached: false,
  };
});

// ------------------------------------------------------------------ thumbnails (A3)

const thumbnails = new Map<string, string>();

function thumbnailSvg(text: string, aspect: string): string {
  const [w, h] = aspect === '16:9' ? [1280, 720] : aspect === '1:1' ? [1080, 1080] : [720, 1280];
  const safe = text.replace(/[<>&"]/g, '').slice(0, 60);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3a12"/><stop offset="1" stop-color="#e3a15b"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><rect x="${w * 0.1}" y="${h * 0.7}" width="${w * 0.8}" height="${h * 0.14}" fill="rgba(0,0,0,0.6)"/><text x="50%" y="${h * 0.79}" font-family="Montserrat, sans-serif" font-size="${Math.round(Math.min(w, h) * 0.07)}" fill="#fff" text-anchor="middle">${safe}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

route('GET', '/renders/:id', ({ params }) => {
  const { project, render } = findRender(params.id ?? '');
  const url =
    thumbnails.get(render.id) ??
    thumbnailSvg(project.brief?.hook ?? project.name ?? '', render.aspectRatio);
  return { render: { ...render, thumbnailUrl: url } };
});

route('POST', '/renders/:id/thumbnail', ({ params, body }) => {
  const { project, render } = findRender(params.id ?? '');
  if (body instanceof FormData) {
    const file = body.get('file');
    if (!(file instanceof Blob)) throw bad('file is required');
    if (!['image/jpeg', 'image/png'].includes(file.type))
      throw bad('Thumbnails must be JPEG or PNG images');
    if (file.size > 8 * 1024 * 1024)
      throw new DemoHttpError(413, 'payload_too_large', 'Thumbnails can be at most 8 MB');
    const url = URL.createObjectURL(file);
    thumbnails.set(render.id, url);
    return { render: { id: render.id, thumbnailUrl: url } };
  }
  const input = (body ?? {}) as { atSec?: unknown; overlayText?: unknown; source?: unknown };
  if (input.atSec !== undefined) {
    if (typeof input.atSec !== 'number' || input.atSec < 0 || input.atSec > render.durationSec)
      throw bad(`atSec must be within the video (0–${render.durationSec.toFixed(1)}s)`);
  }
  const text =
    typeof input.overlayText === 'string' && input.overlayText.trim()
      ? input.overlayText.trim()
      : (project.brief?.hook ?? project.name ?? '');
  const url = thumbnailSvg(text, render.aspectRatio);
  thumbnails.set(render.id, url);
  return { render: { id: render.id, thumbnailUrl: url } };
});

// ------------------------------------------------------------------ captions (A4)

route('GET', '/renders/:id/captions', ({ params }) => {
  const { project, render } = findRender(params.id ?? '');
  const script = project.scripts.find((s) => s.targetPlatform === render.targetPlatform);
  let at = 0;
  const lines = (script?.shots ?? []).flatMap((shot) => {
    const start = at;
    at += shot.durationSec;
    const text = shot.voiceoverText?.trim();
    return text
      ? [
          {
            startAtSec: Math.round((start + 0.3) * 1000) / 1000,
            endAtSec: Math.round((start + Math.max(0.8, shot.durationSec - 0.4)) * 1000) / 1000,
            text,
          },
        ]
      : [];
  });
  return {
    renderId: render.id,
    mode: render.targetPlatform === 'youtube' ? 'srt' : 'burn',
    language: 'en-GB',
    srtUrl: null,
    lines,
  };
});

// ------------------------------------------------------------------ list metrics (A8)

/** Deterministic "live" metrics for published demo rows (the real list reads video_analytics). */
export function demoLatestMetrics(p: Publication): Publication['latestMetrics'] {
  if (p.state !== 'PUBLISHED' || !p.publishedAt) return null;
  const seed = [...p.id].reduce((n, c) => n + c.charCodeAt(0), 0);
  const ageH = Math.max(1, (Date.now() - Date.parse(p.publishedAt)) / 3_600_000);
  const views = Math.round((seed % 90) * 37 + ageH * 41);
  return {
    views,
    likes: Math.round(views * 0.06),
    comments: Math.round(views * 0.008),
    at: new Date(Date.now() - 20 * 60_000).toISOString(),
  };
}
