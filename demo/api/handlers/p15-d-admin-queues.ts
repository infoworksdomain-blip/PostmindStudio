// Phase 15 Track D sample handlers:
//   /admin/queues/:name/failed (+ retry, requeue, drain)   15.D4 (services/dead-letter.ts)
//   /admin/force-approvals                                 15.D5 (services/force-approvals.ts)
// Job data is shown as the real route shows it: secrets and URL query values already redacted.
import { DemoHttpError, route } from '../registry';
import { OTHER_ORGS } from './admin-state';

const QUEUES = [
  'studio-orchestration',
  'studio-assets',
  'studio-publish',
  'studio-scheduled',
  'studio-analytics',
  'studio-library',
];
const PROVIDERS_BY_TIER: Record<string, string[]> = {
  BASIC: ['fal', 'replicate'],
  STANDARD: ['seedance', 'veo', 'runway', 'luma', 'kling'],
  PLUS: ['seedance', 'veo', 'runway', 'luma', 'kling'],
};
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ago: number) => new Date(Date.now() - ago).toISOString();

interface Job {
  queue: string;
  id: string;
  name: string;
  data: Record<string, unknown>;
  failedReason: string;
  attemptsMade: number;
  addedAt: string;
  failedAt: string;
}

const jobs: Job[] = [
  {
    queue: 'studio-assets',
    id: 'generate-asset__shot-harrogate-3__run-7f2c',
    name: 'generate-asset',
    data: {
      organisationId: OTHER_ORGS.harrogate,
      projectId: 'prj-harrogate-latte-art',
      shotId: 'shot-harrogate-3',
      runId: 'run-7f2c',
      planTier: 'STANDARD',
    },
    failedReason: 'runway/provider_unavailable: 503 Service Unavailable',
    attemptsMade: 6,
    addedAt: iso(3 * HOUR),
    failedAt: iso(2 * HOUR),
  },
  {
    queue: 'studio-assets',
    id: 'scan-website__scan-york-12',
    name: 'scan-website',
    data: {
      organisationId: OTHER_ORGS.york,
      businessId: 'biz-york-yoga',
      scanId: 'scan-york-12',
      runId: 'scan-york-12',
      planTier: 'BASIC',
    },
    failedReason:
      'Website did not answer within 30s (https://yorkyoga.example/?utm_source=redacted)',
    attemptsMade: 6,
    addedAt: iso(26 * HOUR),
    failedAt: iso(25 * HOUR),
  },
  {
    queue: 'studio-publish',
    id: 'publish-video__pub-kirkstall-yt-2__0',
    name: 'publish-video',
    data: {
      organisationId: OTHER_ORGS.kirkstall,
      projectId: 'prj-kirkstall-fade-guide',
      publicationId: 'pub-kirkstall-yt-2',
      runId: 'run-11aa',
      planTier: 'PLUS',
    },
    failedReason:
      'youtube/quota_exceeded: The request cannot be completed because you have exceeded your quota.',
    attemptsMade: 6,
    addedAt: iso(5 * HOUR),
    failedAt: iso(4 * HOUR),
  },
  {
    queue: 'studio-library',
    id: 'ingest-library-video__9e1d',
    name: 'ingest-library-video',
    data: {
      organisationId: OTHER_ORGS.platform,
      runId: '9e1d',
      planTier: 'ENTERPRISE',
      item: {
        sourceUrl:
          'https://cdn.partner.example/clip-88.mp4?X-Amz-Signature=redacted&X-Amz-Credential=redacted',
        licenseScenario: 'LICENSED',
        tags: ['coffee'],
      },
    },
    failedReason: 'download failed: 403 Forbidden (signed URL expired)',
    attemptsMade: 6,
    addedAt: iso(30 * HOUR),
    failedAt: iso(29 * HOUR),
  },
];

function queueOf(name: string | undefined): string {
  if (!name || !QUEUES.includes(name))
    throw new DemoHttpError(404, 'not_found', `Unknown queue ${name}`);
  return name;
}

function take(queue: string, id: string | undefined): Job {
  const index = jobs.findIndex((j) => j.queue === queue && j.id === id);
  if (index === -1) throw new DemoHttpError(404, 'not_found', `No failed job ${id} in ${queue}`);
  const [job] = jobs.splice(index, 1);
  return job as Job;
}

const view = (j: Job) => ({
  id: j.id,
  name: j.name,
  data: j.data,
  failedReason: j.failedReason,
  stacktrace: [],
  attemptsMade: j.attemptsMade,
  organisationId: (j.data.organisationId as string | undefined) ?? null,
  projectId: (j.data.projectId as string | undefined) ?? null,
  addedAt: j.addedAt,
  processedAt: j.addedAt,
  failedAt: j.failedAt,
  providerOverride: j.name === 'generate-asset',
});

route('GET', '/admin/queues/:name/failed', ({ params, query }) => {
  const queue = queueOf(params.name);
  const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 25) || 25));
  const offset = Number(atob(query.get('cursor') ?? '').replace(/^o:/, '')) || 0;
  const own = jobs
    .filter((j) => j.queue === queue)
    .sort((a, b) => b.failedAt.localeCompare(a.failedAt));
  const page = own.slice(offset, offset + limit);
  const next = offset + page.length;
  return {
    queue,
    total: own.length,
    jobs: page.map(view),
    nextCursor: next < own.length ? btoa(`o:${next}`) : null,
  };
});

route('POST', '/admin/queues/:name/failed/:jobId/retry', ({ params }) => {
  const job = take(queueOf(params.name), params.jobId);
  return { job: { id: job.id, name: job.name, state: 'waiting' }, advisory: null };
});

route('POST', '/admin/queues/:name/failed/:jobId/requeue', ({ params, body }) => {
  const queue = queueOf(params.name);
  const providerId = (body as { providerId?: string } | undefined)?.providerId;
  const existing = jobs.find((j) => j.queue === queue && j.id === params.jobId);
  if (!existing)
    throw new DemoHttpError(404, 'not_found', `No failed job ${params.jobId} in ${queue}`);
  if (providerId && existing.name !== 'generate-asset')
    throw new DemoHttpError(
      400,
      'validation_error',
      `providerId applies to generate-asset jobs only: ${existing.name} jobs carry no provider preference`,
    );
  const tier = String(existing.data.planTier ?? 'STANDARD');
  const candidates = PROVIDERS_BY_TIER[tier] ?? [];
  if (providerId && !candidates.includes(providerId))
    throw new DemoHttpError(
      400,
      'validation_error',
      `${providerId} is not a candidate for AI_CLIP shots on the ${tier} plan`,
      { candidates },
    );
  const job = take(queue, params.jobId);
  const outcome =
    job.name === 'generate-asset'
      ? {
          action: 'resumed_project',
          projectId: job.data.projectId,
          runId: `run-${Date.now().toString(36)}`,
          jobs: 1,
          ...(providerId && { providerId }),
        }
      : { action: 'requeued' };
  return { job: { id: job.id, name: job.name }, outcome };
});

route('POST', '/admin/queues/:name/failed/drain', ({ params, body }) => {
  const queue = queueOf(params.name);
  const input = (body ?? {}) as { confirm?: string; reason?: string };
  if (!input.reason || input.reason.trim().length < 3)
    throw new DemoHttpError(400, 'validation_error', 'reason must be at least 3 characters');
  if (input.confirm !== queue)
    throw new DemoHttpError(
      400,
      'validation_error',
      `Type the queue name (${queue}) exactly to confirm the drain`,
    );
  const before = jobs.length;
  for (let i = jobs.length - 1; i >= 0; i -= 1) if (jobs[i]?.queue === queue) jobs.splice(i, 1);
  return { queue, removed: before - jobs.length };
});

// ------------------------------------------------------------------ 15.D5 force-approvals

const failedLoudness = {
  code: 'audio_present',
  severity: 'error',
  detail: 'integrated loudness -27.4 LUFS (required -18 to -10)',
};

const approvals = [
  {
    renderId: 'rnd-york-asmr-tiktok',
    targetPlatform: 'tiktok',
    aspectRatio: '9:16',
    renderCreatedAt: iso(2 * 24 * HOUR + 9 * MIN),
    approvedAt: iso(2 * 24 * HOUR),
    approvedAtRecorded: true,
    approvedByUserId: 'user-york-owner',
    note: 'Whisper-quiet on purpose: this is our ASMR stretching series.',
    failedChecks: [failedLoudness],
    project: {
      id: 'prj-york-asmr',
      name: 'Slow stretch ASMR',
      state: 'PUBLISHED',
      businessId: 'biz-york-yoga',
    },
    organisationId: OTHER_ORGS.york,
  },
  {
    renderId: 'rnd-kirkstall-prank-reel',
    targetPlatform: 'instagram_reel',
    aspectRatio: '9:16',
    renderCreatedAt: iso(11 * 24 * HOUR + 20 * MIN),
    approvedAt: iso(11 * 24 * HOUR),
    approvedAtRecorded: true,
    approvedByUserId: 'user-kirkstall-manager',
    note: 'Mock “scandal” clip for April Fools; it is satire.',
    failedChecks: [
      { code: 'black_frames', severity: 'error', detail: '1.2s of black at 00:03 (max 0.5s)' },
    ],
    project: {
      id: 'prj-kirkstall-prank',
      name: 'The great fade scandal',
      state: 'APPROVED',
      businessId: 'biz-kirkstall',
    },
    organisationId: OTHER_ORGS.kirkstall,
  },
  {
    renderId: 'rnd-bramley-legacy',
    targetPlatform: 'youtube_short',
    aspectRatio: '9:16',
    renderCreatedAt: iso(52 * 24 * HOUR),
    approvedAt: iso(52 * 24 * HOUR),
    approvedAtRecorded: false,
    approvedByUserId: 'user-bramley-owner',
    note: 'Duration is fine for Shorts',
    failedChecks: [{ code: 'duration', severity: 'error', detail: '63s (target 60s ±2s)' }],
    project: {
      id: 'prj-bramley-roses',
      name: 'Rose bouquet time-lapse',
      state: 'PUBLISHED',
      businessId: 'biz-bramley',
    },
    organisationId: OTHER_ORGS.bramley,
  },
];

route('GET', '/admin/force-approvals', ({ query }) => {
  const days = Number(query.get('days') ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 90)
    throw new DemoHttpError(400, 'validation_error', 'days must be 1–90');
  const since = Date.now() - days * 24 * HOUR;
  const org = query.get('organisationId');
  return {
    days,
    since: new Date(since).toISOString(),
    truncated: false,
    items: approvals.filter(
      (a) => Date.parse(a.approvedAt) >= since && (!org || a.organisationId === org),
    ),
  };
});
