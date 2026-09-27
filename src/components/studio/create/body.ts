import { buildTargets, type AutoPublishTarget } from '../automation/automation';
import { buildFormats, nameFromBrief, type Length, type TargetFormatInput } from './formats';

// Builds the POST /api/studio/projects body (services/projects.ts createProjectInput) from the
// Create screen's state. Pure, so the rules the API enforces are unit-tested here too.

export type CreateSource = 'BRIEF' | 'SLIDESHOW';
export type ReferenceMode = 'TEMPLATE' | 'INSPIRE';
export type ReviewPolicy = 'AUTO_APPROVE' | 'REQUIRE_APPROVAL';

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
}

export interface Reference {
  id: string;
  mode: ReferenceMode;
}

export interface CreateProjectBody {
  name: string;
  businessId: string;
  sourceType: 'BRIEF' | 'SLIDESHOW' | 'LIBRARY_REFERENCE' | 'TEMPLATE';
  /** Omitted for TEMPLATE projects: the template's formats apply. */
  targetFormats?: TargetFormatInput[];
  templateId?: string;
  publishPolicy?: 'AUTO_ON_APPROVAL';
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
export function validateCreate(state: CreateState, businessId: string | null): string[] {
  const problems: string[] = [];
  const templated = usesTemplate(state);
  if (!businessId) problems.push('Choose a business first.');
  if (!state.brief.trim() && !templated) problems.push('Describe what the video is about.');
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
  if (state.source === 'SLIDESHOW' && state.templateId) {
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
  if (state.autoPublish && state.source === 'BRIEF') {
    body.publishPolicy = 'AUTO_ON_APPROVAL';
    body.autoPublish = {
      targets: buildTargets(
        template ? template.platforms : state.platforms,
        state.autoPublishAccounts,
      ),
    };
  }
  return body;
}

export function parseReference(id: string | undefined, mode: string | undefined): Reference | null {
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return { id, mode: mode?.toUpperCase() === 'TEMPLATE' ? 'TEMPLATE' : 'INSPIRE' };
}
