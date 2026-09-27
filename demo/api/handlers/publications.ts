// GET /publications (manage list + calendar window), GET /publications/:id, and the row actions
// cancel / retry / takedown — same filters, ordering, cursor paging, envelopes and 409 messages
// as src/lib/studio/services/publications.ts. POST /publications (publish panel) belongs to the
// Review area ("make"), which writes to the shared store.
import type { Publication } from '@/lib/client/types';
import { DemoHttpError, route } from '../registry';
import {
  getPublication,
  listPublications,
  simulatePublish,
  updatePublication,
} from './publications-store';

const STATES = ['SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED', 'TAKEN_DOWN'];
const PLATFORMS = [
  'tiktok',
  'instagram_reel',
  'youtube_short',
  'youtube',
  'linkedin_video',
  'x',
  'facebook',
];
/** Publishers with a delete API (platforms/*.ts implement takedown); TikTok has none. */
const TAKEDOWN_PLATFORMS = new Set([
  'instagram_reel',
  'facebook',
  'youtube',
  'youtube_short',
  'linkedin_video',
  'x',
]);

const bad = (message: string) => new DemoHttpError(400, 'validation_error', message);
const conflict = (message: string, details?: Record<string, unknown>) =>
  new DemoHttpError(409, 'conflict', message, details);

function parseTime(value: string | null, field: string): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw bad(`${field}: Invalid ISO datetime`);
  return t;
}

function inWindow(p: Publication, from?: number, to?: number): boolean {
  if (from === undefined && to === undefined) return true;
  const hit = (iso: string | null) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return (from === undefined || t >= from) && (to === undefined || t < to);
  };
  return hit(p.scheduledFor) || hit(p.publishedAt);
}

route('GET', '/publications', ({ query }) => {
  const state = query.get('state');
  const states = state ? state.split(',') : undefined;
  if (states && !states.every((s) => STATES.includes(s)))
    throw bad('state: Unknown publication state');
  const platform = query.get('platform') || undefined;
  if (platform && !PLATFORMS.includes(platform)) throw bad('platform: Invalid option');
  const projectId = query.get('projectId') || undefined;
  const from = parseTime(query.get('from'), 'from');
  const to = parseTime(query.get('to'), 'to');
  const limit = Number(query.get('limit') ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('limit: must be 1–200');

  const all = listPublications().filter(
    (p) =>
      (!states || states.includes(p.state)) &&
      (!platform || p.platform === platform) &&
      (!projectId || p.projectId === projectId) &&
      inWindow(p, from, to),
  );
  const cursor = query.get('cursor');
  const start = cursor ? all.findIndex((p) => p.id === cursor) + 1 : 0;
  const rows = all.slice(start, start + limit + 1);
  const page = rows.slice(0, limit);
  return { data: page, nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
});

function find(id: string): Publication {
  const p = getPublication(id);
  if (!p) throw new DemoHttpError(404, 'not_found', 'Publication not found');
  return p;
}

/** The detail read has no project join (services/publications.ts getPublication). */
function detail(p: Publication): Record<string, unknown> {
  const { project: _project, ...rest } = p;
  void _project;
  return rest;
}

route('GET', '/publications/:id', ({ params }) => ({ publication: detail(find(params.id ?? '')) }));

route('POST', '/publications/:id/cancel', ({ params }) => {
  const p = find(params.id ?? '');
  if (p.state !== 'SCHEDULED' || !p.scheduledFor) {
    throw conflict(
      p.state === 'SCHEDULED'
        ? 'Only scheduled publications can be cancelled; this one is already queued'
        : `Publication is ${p.state}`,
    );
  }
  const updated = updatePublication(p.id, { state: 'CANCELLED' });
  return { publication: detail(updated ?? p) };
});

route('POST', '/publications/:id/retry', ({ params }) => {
  const p = find(params.id ?? '');
  if (p.state !== 'FAILED')
    throw conflict(`Only FAILED publications can be retried (is ${p.state})`);
  const updated = updatePublication(p.id, {
    state: 'SCHEDULED',
    scheduledFor: null,
    errorReason: null,
    errorCode: null,
    retryCount: p.retryCount + 1,
  });
  simulatePublish(p.id);
  return { status: 202, body: { publication: detail(updated ?? p) } };
});

route('POST', '/publications/:id/takedown', ({ params }) => {
  const p = find(params.id ?? '');
  if (p.state !== 'PUBLISHED' || !p.platformPostId)
    throw conflict(`Only published posts can be taken down (is ${p.state})`);
  if (!TAKEDOWN_PLATFORMS.has(p.platform)) {
    throw conflict(
      `${p.platform} has no documented delete API; remove the post in the ${p.platform} app`,
    );
  }
  const updated = updatePublication(p.id, { state: 'TAKEN_DOWN' });
  return { publication: detail(updated ?? p) };
});
