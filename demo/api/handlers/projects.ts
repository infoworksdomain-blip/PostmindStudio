// /projects endpoints for the demo (services/projects.ts shapes): list with state filters and
// cursor pagination, create (brief / slideshow / library reference / template, auto-publish
// targets), detail, edit (budget raise), archive, generate, cancel, reject, duplicate.
import type { TargetFormat } from '@/lib/client/types';
import { DemoHttpError, route } from '../registry';
import { DEMO_BUSINESS_ID, DEMO_USER_ID, LIBRARY_VIDEOS } from '../ids';
import { resumeRendering, startFullRun, stopRun } from './pipeline-sim';
import { startPublicationSync } from './projects-publish';
import { seedProjects } from './projects-seed';
import { claimUpload } from './p13-a1-uploads';
import {
  allProjects,
  baseProject,
  DAY,
  getProject,
  newId,
  nowIso,
  putProject,
  toProject,
  touch,
  type ProjectRec,
} from './projects-store';
import { publicationsForProject } from './publications-store';
import { draftSlides, slidesByProject } from './slideshow-data';
import { findProjectTemplate } from './templates';

seedProjects();
startPublicationSync();

const GENERATABLE = new Set(['DRAFT', 'FAILED', 'REJECTED', 'QUALITY_FAILED', 'READY_FOR_REVIEW']);
const EDITABLE = GENERATABLE;
const ACTIVE = new Set([
  'QUEUED',
  'SCANNING',
  'PLANNING',
  'ASSETS_QUEUED',
  'ASSETS_GENERATING',
  'RENDERING',
  'QUALITY_CHECKING',
]);

type Body = Record<string, unknown>;
const obj = (v: unknown): Body =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Body) : {};
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
const bad = (message: string) => new DemoHttpError(400, 'validation_error', message);

route('GET', '/projects', ({ query }) => {
  const states = query.get('state')?.split(',').filter(Boolean);
  const businessId = query.get('businessId');
  const days = Number(query.get('days') ?? 0);
  const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 20) || 20));
  let rows = allProjects().filter(
    (p) =>
      (!states || states.includes(p.state)) &&
      (!businessId || p.businessId === businessId) &&
      (!days || Date.now() - new Date(p.createdAt).getTime() <= days * DAY),
  );
  const cursor = query.get('cursor');
  if (cursor) rows = rows.slice(rows.findIndex((p) => p.id === cursor) + 1);
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  return {
    data: data.map(toProject),
    nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null,
    hasMore,
  };
});

function formatsFrom(v: unknown): TargetFormat[] {
  if (!Array.isArray(v) || v.length === 0) throw bad('targetFormats is required');
  return v.map((f) => {
    const o = obj(f);
    const platform = str(o.platform);
    if (!platform) throw bad('Each target format needs a platform');
    const aspectRatio = (str(o.aspectRatio) ?? '9:16') as TargetFormat['aspectRatio'];
    return { platform, aspectRatio, duration: Number(o.durationSec ?? o.duration ?? 30) };
  });
}

const defaultBudget = (formats: TargetFormat[]) =>
  formats.some((f) => f.duration > 90) ? 1500 : 500;

route('POST', '/projects', ({ body }) => {
  const b = obj(body);
  const name = str(b.name);
  if (!name) throw bad('name is required');
  const sourceType = (str(b.sourceType) ?? 'BRIEF') as ProjectRec['sourceType'];
  const brief = obj(b.brief);
  const rawInput = str(brief.rawInput);
  const slideshow = obj(b.slideshow);
  const template = sourceType === 'TEMPLATE' ? findProjectTemplate(str(b.templateId) ?? '') : null;
  if (sourceType === 'TEMPLATE' && !template)
    throw new DemoHttpError(404, 'not_found', 'Template not found');
  if (sourceType === 'SLIDESHOW' && !str(slideshow.templateId))
    throw bad('slideshow is required for SLIDESHOW projects');
  if (!['SLIDESHOW', 'TEMPLATE', 'UPLOAD'].includes(sourceType) && !rawInput)
    throw bad('brief is required');
  // 13.5: an UPLOAD project claims a completed source-video upload (p13-a1-uploads.ts).
  const upload = sourceType === 'UPLOAD' ? claimUpload(str(b.uploadId)) : null;
  const referenceVideoId = str(b.referenceVideoId) ?? null;
  if (sourceType === 'LIBRARY_REFERENCE' && !LIBRARY_VIDEOS.some((v) => v.id === referenceVideoId))
    throw bad('referenceVideoId is not an available library video');

  const formats = template
    ? template.targetFormats.map((f) => ({
        ...f,
        aspectRatio: f.aspectRatio as TargetFormat['aspectRatio'],
        duration: f.duration,
      }))
    : formatsFrom(b.targetFormats);
  const defaults = template?.publishDefaults ?? null;
  const targets = (obj(b.autoPublish).targets as unknown[] | undefined) ?? defaults?.targets ?? [];
  const publishPolicy = str(b.publishPolicy) ?? defaults?.publishPolicy ?? 'MANUAL';
  const id = newId('prj');
  const project = baseProject(id, name, {
    state: 'DRAFT',
    scene:
      sourceType === 'SLIDESHOW' ? 'cake' : sourceType === 'UPLOAD' ? 'storefront' : 'sourdough',
    sourceType,
    businessId: str(b.businessId) ?? DEMO_BUSINESS_ID,
    description: template
      ? `${template.name}${rawInput ? ` — ${rawInput}` : ''}`
      : (rawInput ?? str(slideshow.topic) ?? null),
    referenceVideoId: sourceType === 'LIBRARY_REFERENCE' ? referenceVideoId : null,
    referenceMode:
      sourceType === 'LIBRARY_REFERENCE'
        ? ((str(b.referenceMode) ?? 'INSPIRE') as 'TEMPLATE' | 'INSPIRE')
        : null,
    targetFormats: formats,
    brandKitId: str(b.brandKitId) ?? null,
    templateId: template?.id ?? null,
    costBudgetPence:
      typeof b.costBudgetPence === 'number' ? b.costBudgetPence : defaultBudget(formats),
    reviewPolicy: str(b.reviewPolicy) ?? defaults?.reviewPolicy ?? 'REQUIRE_APPROVAL',
    publishPolicy,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    metadata: {
      briefHints: {
        targetAudience: str(brief.targetAudience) ?? null,
        callToAction: str(brief.callToAction) ?? null,
      },
      ...(sourceType === 'SLIDESHOW' && {
        slideshow: { templateId: str(slideshow.templateId), topic: str(slideshow.topic) ?? null },
      }),
      ...(targets.length > 0 && { autoPublish: { targets } }),
      ...(template && { template: { id: template.id } }),
      ...(upload && {
        upload: { id: upload.id, fileName: upload.fileName, durationSec: upload.durationSec },
      }),
      ...(referenceVideoId &&
        sourceType === 'LIBRARY_REFERENCE' && {
          reference: { videoId: referenceVideoId, mode: str(b.referenceMode) },
        }),
    },
  });
  putProject(project);
  if (upload) upload.projectId = id;
  if (sourceType === 'SLIDESHOW')
    slidesByProject.set(
      id,
      draftSlides(id, str(slideshow.templateId) ?? '', str(slideshow.topic) ?? ''),
    );
  return { status: 201, body: { project: toProject(project) } };
});

route('GET', '/projects/:id', ({ params }) => {
  const p = getProject(params.id ?? '');
  resumeRendering(p);
  return {
    project: {
      ...toProject(p),
      brief: p.brief && { ...p.brief, rawInput: p.description ?? '', callToAction: null },
      scripts: p.scripts.map(({ shots, ...s }) => ({
        ...s,
        shots: shots.map((x) => ({
          id: x.id,
          sortOrder: x.sortOrder,
          durationSec: x.durationSec,
          visualTreatment: x.visualTreatment,
          state: x.state,
          errorReason: x.errorReason,
        })),
      })),
      renders: [...p.renders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      publications: publicationsForProject(p.id),
      approvals: p.approvals.map((a) => ({ ...a })),
    },
  };
});

route('GET', '/projects/:id/renders', ({ params }) => ({
  data: getProject(params.id ?? '').renders,
}));
route('GET', '/projects/:id/scripts', ({ params }) => ({
  data: getProject(params.id ?? '').scripts,
}));

route('PATCH', '/projects/:id', ({ params, body }) => {
  const p = getProject(params.id ?? '');
  const b = obj(body);
  // 13.20 (track A3): the auto-resume opt-out alone may change in any state.
  const onlyAutoResume =
    Object.keys(b).length > 0 && Object.keys(b).every((k) => k === 'autoResume');
  if (!onlyAutoResume && !EDITABLE.has(p.state))
    throw new DemoHttpError(409, 'conflict', `Project cannot be edited while ${p.state}`);
  if (Object.keys(b).length === 0) throw bad('Nothing to update');
  if (typeof b.autoResume === 'boolean')
    p.metadata = { ...(p.metadata ?? {}), autoResume: b.autoResume };
  if (b.costBudgetPence !== undefined) {
    const pence = Number(b.costBudgetPence);
    if (!Number.isInteger(pence) || pence < 0 || pence > 10_000_000)
      throw bad('costBudgetPence is invalid');
    p.costBudgetPence = pence;
  }
  if (str(b.name)) p.name = str(b.name) ?? p.name;
  if (b.targetFormats) p.targetFormats = formatsFrom(b.targetFormats);
  if (b.brandKitId !== undefined) p.brandKitId = str(b.brandKitId) ?? null;
  if (str(b.reviewPolicy)) p.reviewPolicy = str(b.reviewPolicy) ?? p.reviewPolicy;
  if (str(b.publishPolicy)) p.publishPolicy = str(b.publishPolicy) ?? p.publishPolicy;
  const brief = obj(b.brief);
  if (str(brief.rawInput)) p.description = str(brief.rawInput) ?? p.description;
  if (b.autoPublish)
    p.metadata = {
      ...(p.metadata ?? {}),
      autoPublish: { targets: obj(b.autoPublish).targets ?? [] },
    };
  return { project: toProject(touch(p)) };
});

route('DELETE', '/projects/:id', ({ params }) => {
  const p = getProject(params.id ?? '');
  if (ACTIVE.has(p.state))
    throw new DemoHttpError(409, 'conflict', 'Cancel generation before archiving');
  touch(p, { state: 'ARCHIVED' });
  return { archived: true };
});

route('POST', '/projects/:id/generate', ({ params, body }) => {
  const p = getProject(params.id ?? '');
  if (!GENERATABLE.has(p.state))
    throw new DemoHttpError(
      409,
      'conflict',
      `Project is ${p.state}; cancel it or wait for it to finish`,
    );
  const rawInput = str(obj(body).rawInput);
  if (rawInput) p.description = rawInput;
  startFullRun(p);
  return {
    status: 202,
    body: {
      projectId: p.id,
      state: 'QUEUED',
      runId: String(p.metadata?.runId ?? ''),
      planTier: 'STANDARD',
    },
  };
});

route('POST', '/projects/:id/cancel', ({ params }) => {
  const p = getProject(params.id ?? '');
  if (!ACTIVE.has(p.state))
    throw new DemoHttpError(409, 'conflict', `Project is ${p.state}; nothing to cancel`);
  stopRun(p.id);
  touch(p, { state: 'FAILED', errorReason: 'cancelled_by_user' });
  return {
    projectId: p.id,
    state: 'FAILED',
    costIncurredPence: p.costActualPence,
    providerJobsCancelled: 2,
  };
});

route('POST', '/projects/:id/reject', ({ params, body }) => {
  const p = getProject(params.id ?? '');
  const note = str(obj(body).note);
  if (!note) throw bad('note is required');
  if (p.state !== 'READY_FOR_REVIEW' && p.state !== 'QUALITY_FAILED')
    throw new DemoHttpError(
      409,
      'conflict',
      `Project is ${p.state}; only reviewable projects can be rejected`,
    );
  p.approvals = [
    {
      id: newId('apr'),
      state: 'REJECTED',
      note,
      createdAt: nowIso(),
      resolvedByUserId: DEMO_USER_ID,
    },
    ...p.approvals,
  ];
  touch(p, { state: 'REJECTED', errorReason: `rejected: ${note}`.slice(0, 2000) });
  return { project: toProject(p) };
});

route('POST', '/projects/:id/duplicate', ({ params }) => {
  const src = getProject(params.id ?? '');
  const copy = baseProject(newId('prj'), `${src.name} (copy)`.slice(0, 200), {
    state: 'DRAFT',
    scene: src.scene,
    sourceType: src.sourceType,
    description: src.description,
    targetFormats: src.targetFormats.map((f) => ({ ...f })),
    brandKitId: src.brandKitId,
    templateId: src.templateId,
    costBudgetPence: src.costBudgetPence,
    reviewPolicy: src.reviewPolicy,
    publishPolicy: src.publishPolicy,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    metadata: { duplicatedFrom: src.id },
  });
  putProject(copy);
  return { status: 201, body: { project: toProject(copy) } };
});
