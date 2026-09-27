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
  /** Pounds as typed; blank = no cap. */
  budgetPounds: string;
  reviewPolicy: ReviewPolicy | '';
}

export interface Reference {
  id: string;
  mode: ReferenceMode;
}

export interface CreateProjectBody {
  name: string;
  businessId: string;
  sourceType: 'BRIEF' | 'SLIDESHOW' | 'LIBRARY_REFERENCE';
  targetFormats: TargetFormatInput[];
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
  if (!businessId) problems.push('Choose a business first.');
  if (!state.brief.trim()) problems.push('Describe what the video is about.');
  if (state.brief.length > BRIEF_MAX)
    problems.push(`Keep the brief under ${BRIEF_MAX} characters.`);
  if (state.platforms.length === 0) problems.push('Pick at least one platform.');
  if (state.source === 'SLIDESHOW' && !state.templateId)
    problems.push('Pick a slideshow template.');
  if (state.budgetPounds.trim()) {
    const value = Number(state.budgetPounds);
    if (!Number.isFinite(value) || value < 0 || value > 100_000)
      problems.push('Budget must be between £0 and £100,000.');
  }
  return problems;
}

export function buildCreateBody(
  state: CreateState,
  businessId: string,
  reference: Reference | null,
): CreateProjectBody {
  const rawInput = state.brief.trim();
  const body: CreateProjectBody = {
    name: nameFromBrief(rawInput),
    businessId,
    sourceType: 'BRIEF',
    targetFormats: buildFormats(state.platforms, state.length),
  };
  if (state.source === 'SLIDESHOW' && state.templateId) {
    body.sourceType = 'SLIDESHOW';
    body.slideshow = { templateId: state.templateId, topic: rawInput.slice(0, 500) };
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
  return body;
}

export function parseReference(id: string | undefined, mode: string | undefined): Reference | null {
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return { id, mode: mode?.toUpperCase() === 'TEMPLATE' ? 'TEMPLATE' : 'INSPIRE' };
}
