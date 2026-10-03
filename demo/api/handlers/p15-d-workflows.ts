// 15.D3 — /approval-workflows sample handlers and the multi-step approve, mirroring
// src/lib/studio/services/approval-workflows.ts (+ approval-workflow-steps.ts): CRUD, appliesTo
// matching (most specific wins), and POST /projects/:id/approve advancing one step at a time —
// the project stays READY_FOR_REVIEW until the last step, then the regular demo approval runs.
//
// This module is imported FIRST in handlers/index.ts so its approve route is matched before the
// single-step one in projects-publish.ts, which it delegates to (via a lazy import, so that
// module still registers its own routes in the usual order) once a review is complete.
import { DEMO_BUSINESS_ID } from '../ids';
import { DemoHttpError, route } from '../registry';
import { getProject, nowIso, toProject, touch, type ProjectRec } from './projects-store';

interface Step {
  role: string;
  minApprovers: number;
}
interface AppliesTo {
  platforms: string[];
  businessIds: string[];
  tags: string[];
}
interface Workflow {
  id: string;
  organisationId: string;
  name: string;
  steps: Step[];
  appliesTo: AppliesTo;
  createdAt: string;
}
interface Round {
  workflow: Workflow;
  approvals: Array<{ stepIndex: number; userId: string; at: string }>;
  outcome?: 'approved';
}

const ORG = 'org-leeds-sourdough';
/** The demo user holds every role, so one person can walk a demo workflow step by step. */
const DEMO_APPROVER = 'user-amara';
const ROLE = /^[a-z][a-z0-9_:-]{0,63}$/;
const PLATFORMS = [
  'tiktok',
  'instagram_reel',
  'youtube_short',
  'youtube',
  'linkedin_video',
  'x',
  'facebook',
  'instagram_feed',
  'facebook_feed',
];

let seq = 3;
const workflows: Workflow[] = [
  {
    id: 'wf-demo-instagram',
    organisationId: ORG,
    name: 'Manager then owner for Instagram',
    steps: [
      { role: 'admin', minApprovers: 1 },
      { role: 'owner', minApprovers: 1 },
    ],
    appliesTo: { businessIds: [DEMO_BUSINESS_ID], platforms: ['instagram_reel'], tags: [] },
    createdAt: '2026-09-01T09:00:00.000Z',
  },
  {
    id: 'wf-demo-wholesale',
    organisationId: ORG,
    name: 'Wholesale client sign-off',
    steps: [
      { role: 'admin', minApprovers: 1 },
      { role: 'client_reviewer', minApprovers: 2 },
    ],
    appliesTo: { businessIds: ['biz-leeds-sourdough-market'], platforms: [], tags: [] },
    createdAt: '2026-09-02T09:00:00.000Z',
  },
];
const rounds = new Map<string, Round>();

const bad = (message: string) => new DemoHttpError(400, 'validation_error', message);

function strings(value: unknown, field: string, allowed?: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim()))
    throw bad(`appliesTo.${field} must be a list of strings`);
  const list = [...new Set((value as string[]).map((v) => v.trim()))];
  if (allowed && list.some((v) => !allowed.includes(v)))
    throw bad(`appliesTo.${field} has an unknown platform`);
  return field === 'tags' ? list.map((t) => t.toLowerCase()) : list;
}

function parseSteps(value: unknown): Step[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10)
    throw bad('steps must list 1–10 steps');
  return value.map((raw, i) => {
    const s = (raw ?? {}) as { role?: unknown; minApprovers?: unknown };
    const role = typeof s.role === 'string' ? s.role.trim().toLowerCase() : '';
    if (!ROLE.test(role)) throw bad(`steps.${i}.role must be a membership role name`);
    const min = s.minApprovers;
    if (typeof min !== 'number' || !Number.isInteger(min) || min < 1 || min > 10)
      throw bad(`steps.${i}.minApprovers must be 1–10`);
    return { role, minApprovers: min };
  });
}

function parseAppliesTo(value: unknown): AppliesTo {
  const a = (value ?? {}) as Record<string, unknown>;
  return {
    businessIds: strings(a.businessIds, 'businessIds'),
    platforms: strings(a.platforms, 'platforms', PLATFORMS),
    tags: strings(a.tags, 'tags'),
  };
}

function parseName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 120) throw bad('name must be 1–120 characters');
  return name;
}

function find(id: string | undefined): Workflow {
  const w = workflows.find((x) => x.id === id);
  if (!w) throw new DemoHttpError(404, 'not_found', 'Approval workflow not found');
  return w;
}

const specificity = (a: AppliesTo) =>
  (a.businessIds.length ? 4 : 0) + (a.tags.length ? 2 : 0) + (a.platforms.length ? 1 : 0);

function matches(a: AppliesTo, businessId: string, platforms: string[]): boolean {
  if (a.businessIds.length && !a.businessIds.includes(businessId)) return false;
  if (a.platforms.length && !a.platforms.some((p) => platforms.includes(p))) return false;
  return a.tags.length === 0; // demo projects carry no tags
}

function matchFor(businessId: string, platforms: string[]): Workflow | null {
  return (
    workflows
      .filter((w) => matches(w.appliesTo, businessId, platforms))
      .sort(
        (a, b) =>
          specificity(b.appliesTo) - specificity(a.appliesTo) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      )[0] ?? null
  );
}

const projectMatch = (p: ProjectRec) =>
  matchFor(
    p.businessId,
    p.targetFormats.map((f) => f.platform),
  );

function progress(round: Round) {
  const steps = round.workflow.steps;
  let current = 0;
  const approversOf = (i: number) =>
    new Set(round.approvals.filter((a) => a.stepIndex === i).map((a) => a.userId)).size;
  while (current < steps.length && approversOf(current) >= (steps[current]?.minApprovers ?? 1))
    current += 1;
  const step = steps[current];
  return {
    current,
    remaining: steps.length - current,
    waitingFor: step
      ? { role: step.role, minApprovers: step.minApprovers, approvals: approversOf(current) }
      : null,
  };
}

// ------------------------------------------------------------------ CRUD

route('GET', '/approval-workflows', ({ query }) => {
  const businessId = query.get('businessId');
  if (!businessId) return { data: workflows };
  const platforms = (query.get('platforms') ?? '').split(',').filter(Boolean);
  return { data: workflows, matched: matchFor(businessId, platforms)?.id ?? null };
});

route('POST', '/approval-workflows', ({ body }) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const workflow: Workflow = {
    id: `wf-demo-${seq++}`,
    organisationId: ORG,
    name: parseName(b.name),
    steps: parseSteps(b.steps),
    appliesTo: parseAppliesTo(b.appliesTo),
    createdAt: nowIso(),
  };
  workflows.push(workflow);
  return { status: 201, body: { workflow } };
});

route('GET', '/approval-workflows/:id', ({ params }) => ({ workflow: find(params.id) }));

route('PATCH', '/approval-workflows/:id', ({ params, body }) => {
  const w = find(params.id);
  const b = (body ?? {}) as Record<string, unknown>;
  if (Object.keys(b).length === 0) throw bad('Nothing to update');
  const next: Workflow = {
    ...w,
    ...(b.name !== undefined && { name: parseName(b.name) }),
    ...(b.steps !== undefined && { steps: parseSteps(b.steps) }),
    ...(b.appliesTo !== undefined && { appliesTo: parseAppliesTo(b.appliesTo) }),
  };
  workflows.splice(workflows.indexOf(w), 1, next);
  return { workflow: next };
});

route('DELETE', '/approval-workflows/:id', ({ params }) => {
  workflows.splice(workflows.indexOf(find(params.id)), 1);
  return { deleted: true };
});

// ------------------------------------------------------------------ approve + status

route('POST', '/projects/:id/approve', async ({ params, body }) => {
  const p = getProject(params.id ?? '');
  if (p.state !== 'READY_FOR_REVIEW')
    throw new DemoHttpError(
      409,
      'conflict',
      `Only READY_FOR_REVIEW projects can be approved (project is ${p.state})`,
    );
  const note = (body as { note?: unknown } | undefined)?.note;
  const existing = rounds.get(p.id);
  const round = existing && !existing.outcome ? existing : null;
  const workflow = round?.workflow ?? projectMatch(p);
  const finish = async () => {
    const { approve } = await import('./projects-publish');
    return approve(p, { note: typeof note === 'string' ? note : undefined });
  };
  if (!workflow) {
    const autoPublish = await finish();
    return {
      project: toProject(p),
      approval: {
        workflowId: null,
        workflowName: null,
        stepIndex: 0,
        stepCount: 1,
        remainingSteps: 0,
        nextStepIndex: null,
        waitingFor: null,
      },
      autoPublish,
      scheduled: [],
    };
  }
  const active: Round = round ?? { workflow: structuredClone(workflow), approvals: [] };
  const { current } = progress(active);
  const step = active.workflow.steps[current];
  if (!step) throw new DemoHttpError(409, 'conflict', 'Every approval step is already complete');
  if (active.approvals.some((a) => a.stepIndex === current && a.userId === DEMO_APPROVER))
    throw new DemoHttpError(
      409,
      'conflict',
      `You have already approved step ${current + 1} of ${active.workflow.steps.length}; it needs ${step.minApprovers} different ${step.role} approvers`,
    );
  active.approvals = [
    ...active.approvals,
    { stepIndex: current, userId: DEMO_APPROVER, at: nowIso() },
  ];
  const after = progress(active);
  const completed = after.waitingFor === null;
  rounds.set(p.id, completed ? { ...active, outcome: 'approved' } : active);
  const approval = {
    workflowId: active.workflow.id,
    workflowName: active.workflow.name,
    stepIndex: current,
    stepCount: active.workflow.steps.length,
    remainingSteps: after.remaining,
    nextStepIndex: completed ? null : after.current,
    waitingFor: after.waitingFor,
  };
  if (completed) {
    const autoPublish = await finish();
    return { project: toProject(p), approval, autoPublish, scheduled: [] };
  }
  touch(p);
  return {
    project: toProject(p),
    approval,
    autoPublish: {
      status: 'skipped',
      reason: `approval step ${current + 1} of ${approval.stepCount} recorded; waiting for the remaining steps`,
    },
    scheduled: [],
  };
});

route('GET', '/projects/:id/approval', ({ params }) => {
  const p = getProject(params.id ?? '');
  const saved = rounds.get(p.id);
  const inReview = p.state === 'READY_FOR_REVIEW' || p.state === 'QUALITY_FAILED';
  const round: Round | null =
    saved && (saved.outcome ? !inReview : true)
      ? saved
      : (() => {
          const w = projectMatch(p);
          return w ? { workflow: w, approvals: [] } : null;
        })();
  if (!round)
    return {
      approval: {
        workflow: null,
        outcome: 'pending',
        started: false,
        stepIndex: 0,
        stepCount: 1,
        remainingSteps: 1,
        waitingFor: null,
        approvals: [],
      },
    };
  const prog = progress(round);
  const stepCount = round.workflow.steps.length;
  const outcome = round.outcome ?? (p.state === 'REJECTED' ? 'rejected' : 'pending');
  return {
    approval: {
      workflow: { id: round.workflow.id, name: round.workflow.name, steps: round.workflow.steps },
      outcome,
      started: round.approvals.length > 0,
      stepIndex: Math.min(prog.current, stepCount - 1),
      stepCount,
      remainingSteps: prog.remaining,
      waitingFor: outcome === 'pending' ? prog.waitingFor : null,
      approvals: round.approvals,
    },
  };
});
