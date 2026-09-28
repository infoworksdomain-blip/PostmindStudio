// Phase 15 track E — data rights, integrations and sharing. Sample handlers for every new
// endpoint, returning the same envelopes as the real routes:
//   15.E1 /account/export             15.E5 /projects/:id/share-links + /public/share-links/:token
//   15.E3 /analytics/engagement-conversations   15.E4 /admin/transparency, /admin/takedown-requests
//   15.E6 PATCH style memory           15.E7 DELETE /slideshow-templates/:id
//   15.E8 /admin/retention (dry run)   15.E2 / E3 / W1 internal endpoints (X-Service-Token)
// Internal endpoints are service-to-service; the demo shows their contract. from-content (15.W1)
// answers the real honest 501 (it waits for Core's content API).
import { DEMO_BUSINESS_ID, DEMO_ORG_ID, PROJECTS } from '../ids';
import { DemoHttpError, route } from '../registry';
import { patchStyleMemory } from './p13-a4-analytics';
import { newId } from './projects-store';
import { findSlideshowTemplate, removeSlideshowTemplate } from './slideshow-data';

const DAY = 86_400_000;
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const bad = (message: string) => new DemoHttpError(400, 'validation_error', message);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// ---------------------------------------------------------------- 15.E1 export

interface DemoExport {
  id: string;
  state: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED';
  include: string[];
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  bytes: number | null;
  errorReason: string | null;
  readyAt: number;
}

const GROUPS = ['projects', 'analytics', 'brand', 'image_library'];
let exports: DemoExport[] = [
  {
    id: 'exp-demo-1',
    state: 'READY',
    include: GROUPS,
    createdAt: iso(-3 * DAY),
    completedAt: iso(-3 * DAY),
    expiresAt: iso(4 * DAY),
    bytes: 482_133,
    errorReason: null,
    readyAt: 0,
  },
];

function tick(e: DemoExport): DemoExport {
  if ((e.state === 'QUEUED' || e.state === 'RUNNING') && Date.now() >= e.readyAt)
    return { ...e, state: 'READY', completedAt: iso(), expiresAt: iso(7 * DAY), bytes: 391_520 };
  if (e.state === 'QUEUED') return { ...e, state: 'RUNNING' };
  return e;
}

const view = ({ readyAt: _r, ...e }: DemoExport) => e;

route('GET', '/account/export', () => {
  exports = exports.map(tick);
  return { data: exports.map(view) };
});

route('POST', '/account/export', ({ body }) => {
  const include = obj(body).include ?? GROUPS;
  if (
    !Array.isArray(include) ||
    include.length === 0 ||
    include.some((g) => !GROUPS.includes(String(g)))
  )
    throw bad('include must list projects, analytics, brand or image_library');
  if (exports.some((e) => e.state === 'QUEUED' || e.state === 'RUNNING'))
    throw new DemoHttpError(
      409,
      'conflict',
      'An export is already being prepared for this organisation',
    );
  const e: DemoExport = {
    id: newId('exp'),
    state: 'QUEUED',
    include: include.map(String),
    createdAt: iso(),
    completedAt: null,
    expiresAt: null,
    bytes: null,
    errorReason: null,
    readyAt: Date.now() + 5_000,
  };
  exports = [e, ...exports];
  return { status: 202, body: { export: view(e) } };
});

route('GET', '/account/export/:id', ({ params }) => {
  exports = exports.map(tick);
  const e = exports.find((x) => x.id === params.id);
  if (!e) throw new DemoHttpError(404, 'not_found', 'Export not found');
  return {
    export: {
      ...view(e),
      ...(e.state === 'READY' && {
        downloadUrl: `data:text/plain,PostMind%20Studio%20demo%20export%20${e.id}`,
      }),
    },
  };
});

// ---------------------------------------------------------------- 15.E5 share links (P8)

interface DemoLink {
  id: string;
  projectId: string;
  token: string;
  state: 'active' | 'expired' | 'revoked';
  expiresAt: string;
  createdAt: string;
  viewCount: number;
  comments: Array<{
    id: string;
    authorName: string;
    authorEmail: string | null;
    body: string;
    createdAt: string;
  }>;
}

const DEMO_TOKEN = 'demoTokenSpringMenu000000000000000000000000';
let links: DemoLink[] = [
  {
    id: 'sl-demo-1',
    projectId: PROJECTS.springMenu.id,
    token: DEMO_TOKEN,
    state: 'active',
    expiresAt: iso(2 * DAY),
    createdAt: iso(-DAY),
    viewCount: 4,
    comments: [
      {
        id: 'slc-1',
        authorName: 'Priya (agency)',
        authorEmail: 'priya@agency.example',
        body: 'Love the opening shot — can the price appear a second earlier?',
        createdAt: iso(-20 * 3_600_000),
      },
      {
        id: 'slc-2',
        authorName: 'سارة',
        authorEmail: null,
        body: 'رائع! الموسيقى مناسبة جدا 👏',
        createdAt: iso(-3 * 3_600_000),
      },
    ],
  },
];

const linkView = ({ token: _t, projectId: _p, ...l }: DemoLink) => l;

route('GET', '/projects/:id/share-links', ({ params }) => ({
  data: links.filter((l) => l.projectId === params.id).map(linkView),
}));

route('POST', '/projects/:id/share-links', ({ params, body }) => {
  const hours = obj(body).expiresInHours ?? 72;
  if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > 168)
    throw bad('expiresInHours must be 1–168');
  const token = `demo${Math.random().toString(36).slice(2)}${'x'.repeat(43)}`.slice(0, 43);
  const l: DemoLink = {
    id: newId('sl'),
    projectId: params.id ?? '',
    token,
    state: 'active',
    expiresAt: iso(hours * 3_600_000),
    createdAt: iso(),
    viewCount: 0,
    comments: [],
  };
  links = [l, ...links];
  return {
    status: 201,
    body: {
      link: {
        id: l.id,
        url: `https://studio.postmind.ai/p/${token}`,
        expiresAt: l.expiresAt,
        createdAt: l.createdAt,
        state: 'active',
      },
    },
  };
});

route('DELETE', '/projects/:id/share-links/:linkId', ({ params }) => {
  const l = links.find((x) => x.id === params.linkId && x.projectId === params.id);
  if (!l) throw new DemoHttpError(404, 'not_found', 'Share link not found');
  links = links.map((x) => (x.id === l.id ? { ...x, state: 'revoked' as const } : x));
  return { link: { id: l.id, revokedAt: iso() } };
});

const DEAD = () =>
  new DemoHttpError(404, 'not_found', 'This preview link is invalid or has expired');

route('GET', '/public/share-links/:token', ({ params }) => {
  const l = links.find((x) => x.token === params.token && x.state === 'active');
  if (!l) throw DEAD();
  links = links.map((x) => (x.id === l.id ? { ...x, viewCount: x.viewCount + 1 } : x));
  return {
    project: { name: PROJECTS.springMenu.name, state: 'READY_FOR_REVIEW' },
    variants: [
      {
        id: 'rnd-demo-tiktok',
        platform: 'tiktok',
        aspectRatio: '9:16',
        durationSec: 24,
        videoUrl: '',
      },
      {
        id: 'rnd-demo-short',
        platform: 'youtube_short',
        aspectRatio: '9:16',
        durationSec: 45,
        videoUrl: '',
      },
    ],
    comments: l.comments.map(({ authorEmail: _e, ...c }) => c),
    expiresAt: l.expiresAt,
    canApprove: false,
  };
});

route('POST', '/public/share-links/:token/comments', ({ params, body }) => {
  const l = links.find((x) => x.token === params.token && x.state === 'active');
  if (!l) throw DEAD();
  const b = obj(body);
  const authorName = typeof b.authorName === 'string' ? b.authorName.trim() : '';
  const text = typeof b.body === 'string' ? b.body.trim() : '';
  if (
    !authorName ||
    !text ||
    Object.keys(b).some((k) => !['authorName', 'authorEmail', 'body'].includes(k))
  )
    throw bad('Request body failed validation');
  const comment = {
    id: newId('slc'),
    authorName: authorName.slice(0, 80),
    authorEmail: typeof b.authorEmail === 'string' ? b.authorEmail : null,
    body: text.slice(0, 2_000),
    createdAt: iso(),
  };
  links = links.map((x) => (x.id === l.id ? { ...x, comments: [...x.comments, comment] } : x));
  const { authorEmail: _e, ...pub } = comment;
  return { status: 201, body: { comment: pub } };
});

// ---------------------------------------------------------------- 15.E6 / 15.E7

route('PATCH', '/businesses/:id/style-memory/:memoryId', ({ params, body }) => {
  const b = obj(body);
  if (Object.keys(b).length === 0) throw bad('Nothing to update');
  const change = {
    ...(typeof b.value === 'string' && {
      value: b.value.trim().slice(0, 200),
      pinned: b.pinned !== false,
    }),
    ...(typeof b.pinned === 'boolean' && { pinned: b.pinned }),
    ...(typeof b.disabled === 'boolean' && { disabled: b.disabled }),
  };
  const memory =
    params.id === DEMO_BUSINESS_ID ? patchStyleMemory(params.memoryId ?? '', change) : undefined;
  if (!memory) throw new DemoHttpError(404, 'not_found', 'Style memory not found');
  return { memory };
});

route('DELETE', '/slideshow-templates/:id', ({ params }) => {
  const t = findSlideshowTemplate(params.id ?? '');
  if (!t || (t.organisationId && t.organisationId !== DEMO_ORG_ID))
    throw new DemoHttpError(404, 'not_found', 'Template not found');
  if (!t.organisationId)
    throw new DemoHttpError(403, 'forbidden', 'Built-in templates cannot be deleted');
  removeSlideshowTemplate(t.id);
  return { deleted: true };
});

// ---------------------------------------------------------------- 15.E3 engagement report

route('GET', '/analytics/engagement-conversations', ({ query }) => ({
  report: {
    days: Number(query.get('days') ?? 30),
    totals: { publications: 5, conversations: 23, leads: 6 },
    byProject: [
      {
        projectId: PROJECTS.sourdoughClass.id,
        name: PROJECTS.sourdoughClass.name,
        hook: 'Your first loaf in 3 hours',
        publications: 3,
        conversations: 17,
        leads: 5,
      },
      {
        projectId: PROJECTS.springMenu.id,
        name: PROJECTS.springMenu.name,
        hook: 'Friday means sourdough',
        publications: 2,
        conversations: 6,
        leads: 1,
      },
    ],
    byHook: [
      {
        hook: 'Your first loaf in 3 hours',
        projects: 1,
        conversations: 17,
        leads: 5,
        leadRate: 0.29,
      },
      { hook: 'Friday means sourdough', projects: 1, conversations: 6, leads: 1, leadRate: 0.17 },
    ],
    byPlatform: [
      {
        platform: 'instagram_reel',
        publications: 2,
        conversations: 14,
        leads: 4,
        perPublication: 7,
      },
      { platform: 'tiktok', publications: 3, conversations: 9, leads: 2, perPublication: 3 },
    ],
  },
}));

// ---------------------------------------------------------------- 15.E4 / 15.E8 staff

type Takedown = Record<string, unknown> & { id: string; state: string };

let takedowns: Takedown[] = [
  {
    id: 'td-1',
    receivedAt: iso(-40 * DAY),
    source: 'policy_mailbox',
    category: 'copyright',
    requester: 'Music label',
    reference: 'CR-2026-11',
    organisationId: DEMO_ORG_ID,
    publicationId: null,
    summary: 'Claim on background track in a published Reel',
    state: 'ACTIONED',
    resolutionNote: 'Track replaced and re-rendered',
  },
];

route('GET', '/admin/takedown-requests', () => ({ data: takedowns }));

route('POST', '/admin/takedown-requests', ({ body }) => {
  const b = obj(body);
  if (typeof b.summary !== 'string' || typeof b.receivedAt !== 'string')
    throw bad('Request body failed validation');
  const request = {
    id: newId('td'),
    state: 'OPEN',
    resolutionNote: null,
    requester: null,
    reference: null,
    organisationId: null,
    publicationId: null,
    source: 'other',
    category: 'other',
    ...b,
  } as Takedown;
  takedowns = [request, ...takedowns];
  return { status: 201, body: { request } };
});

route('PATCH', '/admin/takedown-requests/:id', ({ params, body }) => {
  const t = takedowns.find((x) => x.id === params.id);
  if (!t) throw new DemoHttpError(404, 'not_found', 'Takedown request not found');
  if (t.state !== 'OPEN') throw new DemoHttpError(409, 'conflict', `Request is already ${t.state}`);
  const b = obj(body);
  const request = { ...t, state: String(b.state), resolutionNote: String(b.resolutionNote ?? '') };
  takedowns = takedowns.map((x) => (x.id === t.id ? request : x));
  return { request };
});

route('GET', '/admin/transparency', ({ query }) => ({
  report: {
    year: Number(query.get('year') ?? new Date().getUTCFullYear()),
    generatedAt: iso(),
    contentSafetyBlocks: { total: 14, scriptSafety: 9, contentSafety: 3, reviewQueue: 2 },
    takedownRequests: {
      total: 1,
      bySource: { policy_mailbox: 1 },
      byCategory: { copyright: 1 },
      byOutcome: { ACTIONED: 1 },
    },
    platformMandatedRemovals: { total: 0, byCategory: {} },
    notes: ['Sample figures in the demo build.'],
  },
}));

route('GET', '/admin/retention', () => ({
  dryRun: true,
  rules: [
    {
      rule: 'provider_jobs',
      description: 'Provider job rows older than 60 days',
      cutoff: iso(-60 * DAY),
      due: 1_240,
    },
    {
      rule: 'provider_usage',
      description: 'Provider usage daily summaries older than 12 months',
      cutoff: iso(-365 * DAY),
      due: 0,
    },
    {
      rule: 'video_assets',
      description: 'Assets of projects deleted more than 30 days ago',
      cutoff: iso(-30 * DAY),
      due: 38,
    },
    {
      rule: 'video_renders',
      description: 'Unpublished renders of projects deleted more than 90 days ago',
      cutoff: iso(-90 * DAY),
      due: 4,
    },
    {
      rule: 'approval_tasks',
      description: 'Approval tasks resolved more than 12 months ago',
      cutoff: iso(-365 * DAY),
      due: 0,
    },
    {
      rule: 'data_exports',
      description: 'Data-export downloads past their 7-day link',
      cutoff: iso(),
      due: 1,
    },
    {
      rule: 'business_purges',
      description: 'Deleted businesses past their 30-day grace',
      cutoff: iso(),
      due: 0,
    },
  ],
}));

// ---------------------------------------------------------------- internal (contracts)

route('POST', '/internal/projects/from-content', () => {
  throw new DemoHttpError(
    501,
    'not_implemented',
    'waiting for Core content API (GET /api/internal/content/:id)',
  );
});

route('POST', '/internal/businesses/:id/purge', ({ params, body }) => {
  if (typeof obj(body).organisationId !== 'string') throw bad('Request body failed validation');
  return {
    status: 202,
    body: {
      purge: {
        organisationId: obj(body).organisationId,
        businessId: params.id,
        projectsDeleted: 0,
        publicationsCancelled: 0,
        styleMemoriesDeleted: 0,
        channelsWiped: 0,
        requestedAt: iso(),
        graceUntil: iso(30 * DAY),
        repeated: false,
      },
    },
  };
});

route('POST', '/internal/publications/:id/attribute-conversation', ({ params, body }) => {
  const b = obj(body);
  if (typeof b.conversationId !== 'string') throw bad('Request body failed validation');
  return {
    attributed: true,
    publicationId: params.id,
    conversationId: b.conversationId,
    isLead: b.isLead === true,
    repeated: false,
  };
});
