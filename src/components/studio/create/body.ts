import { buildTargets, type AutoPublishTarget } from '../automation/automation';
import { buildFormats, nameFromBrief, type Length, type TargetFormatInput } from './formats';

// Builds the POST /api/studio/projects body (services/projects.ts createProjectInput) from the
// Create screen's state. Pure, so the rules the API enforces are unit-tested here too.

export type CreateSource = 'BRIEF' | 'SLIDESHOW' | 'UPLOAD';
export type ReferenceMode = 'TEMPLATE' | 'INSPIRE';
export type ReviewPolicy = 'AUTO_APPROVE' | 'REQUIRE_APPROVAL';
export type QualityTier = 'BASIC' | 'STANDARD' | 'PLUS' | 'ENTERPRISE';

const TIER_ORDER: QualityTier[] = ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'];

/** 15.C4: tiers a run may use — the plan's and the cheaper ones (never above the plan). */
export function tiersAtOrBelow(plan: QualityTier): QualityTier[] {
  return TIER_ORDER.slice(0, TIER_ORDER.indexOf(plan) + 1);
}

export interface CreateState {
  brief: string;
  source: CreateSource;
  platforms: string[];
  length: Length;
  brandKitId: string | null;
  templateId: string | null;
  targetAudience: string;
  callToAction: string;
  /** Pounds as typed; blank = the server's default budget (cost/project-budget.ts). */
  budgetPounds: string;
  reviewPolicy: ReviewPolicy | '';
  /** Project template (spec 8.6): its formats replace the platform/length choice. */
  projectTemplate: { id: string; name: string; platforms: string[] } | null;
  /** publishPolicy AUTO_ON_APPROVAL with one chosen connection per platform. */
  autoPublish: boolean;
  autoPublishAccounts: Record<string, string>;
  /** 13.5: the completed source-video upload (POST /uploads → /complete). */
  upload?: { id: string; fileName: string } | null;
  /** 15.C5: the video's language (BCP 47) and extra languages (one variant set each). */
  language?: string;
  extraLanguages?: string[];
  /** 15.C4 / 15.A5: publish at this local date-time ('' = not scheduled). */
  scheduleAt?: string;
  /** 15.C4: a lower tier for this run ('' = the plan's). */
  qualityTier?: QualityTier | '';
  /** 15.C4: an approval workflow (15.D3); '' = the organisation's matching rule. */
  approvalWorkflowId?: string;
}

export interface Reference {
  id: string;
  mode: ReferenceMode;
}

export interface CreateProjectBody {
  name: string;
  businessId: string;
  sourceType: 'BRIEF' | 'SLIDESHOW' | 'LIBRARY_REFERENCE' | 'TEMPLATE' | 'UPLOAD';
  uploadId?: string;
  /** Omitted for TEMPLATE projects: the template's formats apply. */
  targetFormats?: TargetFormatInput[];
  templateId?: string;
  publishPolicy?: 'AUTO_ON_APPROVAL' | 'SCHEDULED';
  scheduledStartAt?: string;
  language?: string;
  languages?: string[];
  approvalWorkflowId?: string;
  autoPublish?: { targets: AutoPublishTarget[] };
  brief?: { rawInput: string; targetAudience?: string; callToAction?: string };
  slideshow?: { templateId: string; topic?: string };
  referenceVideoId?: string;
  referenceMode?: ReferenceMode;
  brandKitId?: string;
  costBudgetPence?: number;
  reviewPolicy?: ReviewPolicy;
}

export const BRIEF_MAX = 4_000;

/** Problems that stop submission (empty = OK). */
export function validateCreate(
  state: CreateState,
  businessId: string | null,
  now: number = Date.now(),
): string[] {
  const problems: string[] = [];
  const templated = usesTemplate(state);
  if (!businessId) problems.push('Choose a business first.');
  const uploading = state.source === 'UPLOAD';
  if (uploading && !state.upload) problems.push('Upload your video first.');
  if (!state.brief.trim() && !templated && !uploading)
    problems.push('Describe what the video is about.');
  if (state.brief.length > BRIEF_MAX)
    problems.push(`Keep the brief under ${BRIEF_MAX} characters.`);
  if (state.platforms.length === 0 && !templated) problems.push('Pick at least one platform.');
  if (
    state.autoPublish &&
    buildTargets(publishPlatforms(state), state.autoPublishAccounts).length === 0
  )
    problems.push('Choose at least one account to auto-publish to, or turn auto-publish off.');
  if (state.source === 'SLIDESHOW' && !state.templateId)
    problems.push('Pick a slideshow template.');
  if (state.scheduleAt) {
    const at = Date.parse(state.scheduleAt);
    if (!Number.isFinite(at) || at <= now) problems.push('Schedule a time in the future.');
    else if (!state.autoPublish && state.source !== 'SLIDESHOW')
      problems.push('Choose the accounts to publish to (auto-publish) for a scheduled video.');
  }
  if (state.budgetPounds.trim()) {
    const value = Number(state.budgetPounds);
    if (!Number.isFinite(value) || value < 0 || value > 100_000)
      problems.push('Budget must be between £0 and £100,000.');
  }
  return problems;
}

/** A template applies to video projects without a library reference. */
export function usesTemplate(state: CreateState, reference: Reference | null = null): boolean {
  return state.source === 'BRIEF' && state.projectTemplate !== null && reference === null;
}

/** Platforms the video will be rendered for (the template's when one is chosen). */
export function publishPlatforms(state: CreateState): string[] {
  return usesTemplate(state) && state.projectTemplate
    ? state.projectTemplate.platforms
    : state.platforms;
}

export function buildCreateBody(
  state: CreateState,
  businessId: string,
  reference: Reference | null,
): CreateProjectBody {
  const rawInput = state.brief.trim();
  const template = usesTemplate(state, reference) ? state.projectTemplate : null;
  const body: CreateProjectBody = {
    name: rawInput ? nameFromBrief(rawInput) : (template?.name ?? 'Untitled video'),
    businessId,
    sourceType: 'BRIEF',
    ...(!template && { targetFormats: buildFormats(state.platforms, state.length) }),
  };
  if (state.source === 'UPLOAD' && state.upload) {
    body.sourceType = 'UPLOAD';
    body.uploadId = state.upload.id;
    if (!rawInput) body.name = nameFromBrief(state.upload.fileName.replace(/.[a-z0-9]+$/i, ''));
    if (rawInput) body.brief = { rawInput };
  } else if (state.source === 'SLIDESHOW' && state.templateId) {
    body.sourceType = 'SLIDESHOW';
    body.slideshow = { templateId: state.templateId, topic: rawInput.slice(0, 500) };
  } else if (template) {
    body.sourceType = 'TEMPLATE';
    body.templateId = template.id;
    if (rawInput)
      body.brief = {
        rawInput,
        ...(state.targetAudience.trim() && { targetAudience: state.targetAudience.trim() }),
        ...(state.callToAction.trim() && { callToAction: state.callToAction.trim() }),
      };
  } else {
    body.brief = {
      rawInput,
      ...(state.targetAudience.trim() && { targetAudience: state.targetAudience.trim() }),
      ...(state.callToAction.trim() && { callToAction: state.callToAction.trim() }),
    };
    if (reference) {
      body.sourceType = 'LIBRARY_REFERENCE';
      body.referenceVideoId = reference.id;
      body.referenceMode = reference.mode;
    }
  }
  if (state.brandKitId) body.brandKitId = state.brandKitId;
  if (state.budgetPounds.trim())
    body.costBudgetPence = Math.round(Number(state.budgetPounds) * 100);
  if (state.reviewPolicy) body.reviewPolicy = state.reviewPolicy;
  if (state.language) body.language = state.language;
  const extras = (state.extraLanguages ?? []).filter((l) => l !== state.language);
  if (extras.length) body.languages = extras;
  if (state.approvalWorkflowId) body.approvalWorkflowId = state.approvalWorkflowId;
  if (state.autoPublish && state.source !== 'SLIDESHOW') {
    body.publishPolicy = 'AUTO_ON_APPROVAL';
    // 15.A5: a scheduled project publishes to the same targets at the chosen time.
    if (state.scheduleAt) {
      body.publishPolicy = 'SCHEDULED';
      body.scheduledStartAt = new Date(state.scheduleAt).toISOString();
    }
    body.autoPublish = {
      targets: buildTargets(
        template ? template.platforms : state.platforms,
        state.autoPublishAccounts,
      ),
    };
  }
  return body;
}

/** 15.C4: the POST /projects/:id/generate body (a lower tier for this run, when chosen). */
export function buildGenerateBody(state: CreateState): { qualityTier?: QualityTier } {
  return state.qualityTier ? { qualityTier: state.qualityTier } : {};
}

export function parseReference(id: string | undefined, mode: string | undefined): Reference | null {
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return { id, mode: mode?.toUpperCase() === 'TEMPLATE' ? 'TEMPLATE' : 'INSPIRE' };
}
