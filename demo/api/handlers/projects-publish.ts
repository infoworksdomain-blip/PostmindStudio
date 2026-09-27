// Approval + publishing for the demo projects: POST /publications (Review → Publish tab),
// approve / auto-approve with auto-publish on approval, and keeping a project's state in step
// with its publications (PUBLISHING → PUBLISHED / PARTIALLY_PUBLISHED).
//
// Shared-store contract (publications-store.ts, owned by agent "manage"): rows are added with
// addPublication() — always with `project: { id, name }` — publish-now rows are created
// SCHEDULED with scheduledFor null and handed to simulatePublish(id); cancel / retry / takedown
// routes are manage's. onPublicationsChange() drives the project-state sync below.
// demoPublicationsFromAutoPublish() lists the publications auto-publish created in this session.
import type { Publication, Render } from '@/lib/client/types';
import { DemoHttpError, route } from '../registry';
import { DEMO_USER_ID } from '../ids';
import { listConnections } from './connections';
import {
  addPublication,
  onPublicationsChange,
  publicationsForProject,
  simulatePublish,
} from './publications-store';
import {
  allProjects,
  findRender,
  getProject,
  newId,
  nowIso,
  setMeta,
  toProject,
  touch,
  type ProjectRec,
} from './projects-store';

export const PUBLISHABLE = new Set(['APPROVED', 'PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED']);
const RENDER_OK = new Set<Render['qualityCheckState']>(['PASSED', 'FORCE_APPROVED']);
const CONNECTION_PLATFORM: Record<string, string> = {
  tiktok: 'tiktok',
  youtube_short: 'youtube',
  youtube: 'youtube',
  linkedin_video: 'linkedin',
  x: 'x',
  instagram_reel: 'instagram',
  facebook: 'facebook',
};

const autoPublished: string[] = [];
/** Publications created by auto-publish on approval during this session (ids, oldest first). */
export function demoPublicationsFromAutoPublish(): string[] {
  return [...autoPublished];
}

interface NewPublication {
  project: ProjectRec;
  render: Render;
  connectionId: string;
  caption: string | null;
  hashtags: string[];
  scheduledFor: string | null;
}

function connectionFor(platform: string, connectionId: string) {
  const needed = CONNECTION_PLATFORM[platform];
  const c = listConnections().find((x) => x.id === connectionId);
  if (!c || c.platform !== needed)
    throw new DemoHttpError(
      400,
      'validation_error',
      `connectionId is not a ${needed ?? platform} connection in this organisation`,
    );
  if (c.state !== 'active')
    throw new DemoHttpError(409, 'conflict', `The ${needed} connection needs reconnecting`);
  return c;
}

function createPublication(n: NewPublication): Publication {
  const c = connectionFor(n.render.targetPlatform, n.connectionId);
  const row: Publication = {
    id: newId('pub'),
    projectId: n.project.id,
    renderId: n.render.id,
    platform: n.render.targetPlatform,
    platformAccountId: c.platformAccountId,
    state: 'SCHEDULED',
    scheduledFor: n.scheduledFor,
    publishedAt: null,
    platformPostId: null,
    platformUrl: null,
    caption: n.caption,
    hashtags: n.hashtags,
    errorReason: null,
    errorCode: null,
    retryCount: 0,
    createdAt: nowIso(),
    project: { id: n.project.id, name: n.project.name },
  };
  const saved = addPublication(row);
  if (!n.scheduledFor) simulatePublish(saved.id);
  return saved;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

route('POST', '/publications', ({ body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const renderId = typeof b.renderId === 'string' ? b.renderId : '';
  const { project, render } = findRender(renderId);
  if (!PUBLISHABLE.has(project.state))
    throw new DemoHttpError(
      409,
      'conflict',
      `Project is ${project.state}; approve it before publishing`,
    );
  if (!RENDER_OK.has(render.qualityCheckState))
    throw new DemoHttpError(409, 'conflict', `Render quality check is ${render.qualityCheckState}`);
  const scheduledFor = typeof b.scheduledFor === 'string' ? b.scheduledFor : null;
  if (scheduledFor && new Date(scheduledFor).getTime() < Date.now() + 5 * 60_000)
    throw new DemoHttpError(
      400,
      'validation_error',
      'scheduledFor must be at least 5 minutes from now',
    );
  const publication = createPublication({
    project,
    render,
    connectionId: typeof b.connectionId === 'string' ? b.connectionId : '',
    caption: typeof b.caption === 'string' && b.caption ? b.caption : null,
    hashtags: strings(b.hashtags),
    scheduledFor,
  });
  if (!scheduledFor && project.state === 'APPROVED') touch(project, { state: 'PUBLISHING' });
  return { status: 202, body: { publication } };
});

// ------------------------------------------------------------------ approval + auto-publish

interface Target {
  platform: string;
  connectionId?: string;
  caption?: string;
  hashtags?: string[];
  scheduleOffsetMinutes?: number;
}

function targetsOf(p: ProjectRec): Target[] {
  const t = (p.metadata?.autoPublish as { targets?: unknown } | undefined)?.targets;
  return Array.isArray(t) ? (t as Target[]) : [];
}

function publishOnApproval(p: ProjectRec, trigger: 'human' | 'auto') {
  if (p.publishPolicy !== 'AUTO_ON_APPROVAL') return null;
  const targets = targetsOf(p);
  let immediate = false;
  const results = targets.map((t, index) => {
    const render = p.renders.find(
      (r) => r.targetPlatform === t.platform && RENDER_OK.has(r.qualityCheckState),
    );
    const account =
      listConnections().find((c) => c.id === t.connectionId)?.platformAccountName ?? null;
    try {
      if (!render) throw new DemoHttpError(409, 'conflict', `No approved ${t.platform} render`);
      const scheduledFor = t.scheduleOffsetMinutes
        ? new Date(Date.now() + t.scheduleOffsetMinutes * 60_000).toISOString()
        : null;
      const pub = createPublication({
        project: p,
        render,
        connectionId: t.connectionId ?? '',
        caption: t.caption ?? p.brief?.hook ?? null,
        hashtags: t.hashtags ?? [],
        scheduledFor,
      });
      autoPublished.push(pub.id);
      if (!scheduledFor) immediate = true;
      return {
        index,
        platform: t.platform,
        account,
        status: 'created' as const,
        publicationId: pub.id,
        scheduledFor,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'failed';
      return { index, platform: t.platform, account, status: 'failed' as const, error };
    }
  });
  const created = results.filter((r) => r.status === 'created').length;
  const result = {
    at: nowIso(),
    trigger,
    status:
      targets.length === 0
        ? 'no_targets'
        : created === targets.length
          ? 'created'
          : created
            ? 'partial'
            : 'failed',
    results,
  };
  setMeta(p, { autoPublishResult: result });
  if (immediate) p.state = 'PUBLISHING';
  return result;
}

/** Approve (by a person or automatically), then publish to the stored targets if armed. */
export function approve(p: ProjectRec, opts: { note?: string; auto?: boolean }) {
  const at = nowIso();
  p.approvals = [
    {
      id: newId('apr'),
      state: 'APPROVED',
      note: opts.note ?? (opts.auto ? 'Auto-approved: trusted creator, all checks passed.' : null),
      createdAt: at,
      resolvedByUserId: opts.auto ? 'system:auto-approve' : DEMO_USER_ID,
    },
    ...p.approvals,
  ];
  touch(p, { state: 'APPROVED', errorReason: null });
  if (opts.auto) setMeta(p, { review: { decision: 'auto_approved', code: 'trusted_creator', at } });
  return publishOnApproval(p, opts.auto ? 'auto' : 'human');
}

route('POST', '/projects/:id/approve', ({ params, body }) => {
  const p = getProject(params.id ?? '');
  if (p.state !== 'READY_FOR_REVIEW')
    throw new DemoHttpError(
      409,
      'conflict',
      `Only READY_FOR_REVIEW projects can be approved (project is ${p.state})`,
    );
  const note = (body as { note?: unknown } | undefined)?.note;
  const autoPublish = approve(p, { note: typeof note === 'string' ? note : undefined });
  return { project: toProject(p), autoPublish };
});

// ------------------------------------------------------------------ state sync

const signatures = new Map<string, string>();
const signature = (id: string) =>
  publicationsForProject(id)
    .map((x) => `${x.id}:${x.state}`)
    .join('|');

function syncState(p: ProjectRec): void {
  const pubs = publicationsForProject(p.id).filter(
    (x) => x.state !== 'CANCELLED' && x.state !== 'TAKEN_DOWN',
  );
  const inFlight = pubs.some(
    (x) => x.state === 'PUBLISHING' || (x.state === 'SCHEDULED' && !x.scheduledFor),
  );
  const live = pubs.filter((x) => x.state === 'PUBLISHED').length;
  const failed = pubs.filter((x) => x.state === 'FAILED').length;
  const next = inFlight
    ? 'PUBLISHING'
    : live && failed
      ? 'PARTIALLY_PUBLISHED'
      : live
        ? 'PUBLISHED'
        : failed
          ? 'PARTIALLY_PUBLISHED'
          : 'APPROVED';
  if (next !== p.state)
    touch(p, { state: next, ...(next === 'PUBLISHED' && { completedAt: nowIso() }) });
}

export function startPublicationSync(): void {
  for (const p of allProjects()) signatures.set(p.id, signature(p.id));
  onPublicationsChange(() => {
    for (const p of allProjects()) {
      const sig = signature(p.id);
      if (sig === signatures.get(p.id)) continue;
      signatures.set(p.id, sig);
      if (PUBLISHABLE.has(p.state)) syncState(p);
    }
  });
}
