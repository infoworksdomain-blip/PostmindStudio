import { isBeyondScheduleWindow } from '@/lib/studio/schedule-window';
import { buildTargets, type AutoPublishTarget } from '../automation/automation';
import { buildFormats, nameFromBrief, type Length, type TargetFormatInput } from './formats';
import {
  CAROUSEL_POSTS_DEFAULT,
  CAROUSEL_POSTS_MAX,
  CAROUSEL_POSTS_MIN,
  EMPTY_HOOK_DEMO,
  EMPTY_UGC,
  EMPTY_WALL_OF_TEXT,
  ugcBody,
  type CarouselTheme,
  type HookDemoChoice,
  type UgcBody,
  type UgcChoice,
  type WallOfTextChoice,
} from './format-choices';
import { validateCarousel, validateHookDemo, validateWall } from './format-validation';

export * from './format-choices';
export * from './create-params';

// Builds the POST /api/studio/projects body (services/projects.ts createProjectInput) from the
// Create screen's state. Pure, so the rules the API enforces are unit-tested here too.

export type CreateSource =
  'BRIEF' | 'SLIDESHOW' | 'UPLOAD' | 'UGC' | 'CAROUSEL' | 'HOOK_DEMO' | 'WALL_OF_TEXT';
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
  /**
   * publishPolicy AUTO_ON_APPROVAL with one chosen connection per platform (videos, slideshows
   * and uploads alike; 20.12).
   */
  autoPublish: boolean;
  autoPublishAccounts: Record<string, string>;
  /** 13.5: the completed source-video upload (POST /uploads → /complete). */
  upload?: { id: string; fileName: string } | null;
  /** 15.C5: the video's language (BCP 47) and extra languages (one variant set each). */
  language?: string;
  extraLanguages?: string[];
  /** 15.C4 / 15.A5: publish at this local date-time ('' = not scheduled). */
  scheduleAt?: string;
  /** 20.3: no date — the business's drip queue gives it the next free posting time. */
  scheduleNextSlot?: boolean;
  /** 15.C4: a lower tier for this run ('' = the plan's). */
  qualityTier?: QualityTier | '';
  /** 15.C4: an approval workflow (15.D3); '' = the organisation's matching rule. */
  approvalWorkflowId?: string;
  /** 21.6 carousels: look, number of posts, and a thread the owner already wrote. */
  carouselTheme?: CarouselTheme;
  carouselPosts?: number;
  carouselThread?: string;
  /** 21.4: the UGC actor choices (source 'UGC'). */
  ugc?: UgcChoice;
  /** 22.1 / 22.2: the Fastlane-style formats' choices. */
  hookDemo?: HookDemoChoice;
  wallOfText?: WallOfTextChoice;
  /** 25.8: the AI-clip model (a providerId); null / absent = Automatic (generate-body.ts). */
  videoModel?: string | null;
}

export interface Reference {
  id: string;
  mode: ReferenceMode;
}

export interface CreateProjectBody {
  /** 17.9: omitted when there is nothing to name the project after (stored as null). */
  name?: string;
  businessId: string;
  sourceType:
    | 'BRIEF'
    | 'SLIDESHOW'
    | 'LIBRARY_REFERENCE'
    | 'TEMPLATE'
    | 'UPLOAD'
    | 'CAROUSEL'
    | 'HOOK_DEMO'
    | 'WALL_OF_TEXT';
  carousel?: { theme: CarouselTheme; postCount: number; thread?: string };
  hookDemo?: Omit<HookDemoChoice, 'demoUploadId' | 'hookLine'> & {
    demoUploadId: string;
    hookLine?: string;
  };
  wallOfText?: Omit<WallOfTextChoice, 'text'> & { text?: string };
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
  ugc?: UgcBody;
  brief?: { rawInput: string; targetAudience?: string; callToAction?: string };
  slideshow?: { templateId: string; topic?: string };
  referenceVideoId?: string;
  referenceMode?: ReferenceMode;
  brandKitId?: string;
  costBudgetPence?: number;
  reviewPolicy?: ReviewPolicy;
}

export const BRIEF_MAX = 4_000;

/** Why submission is blocked; each code is a message key (create.problems.*). */
export type CreateProblem =
  | 'businessRequired'
  | 'uploadRequired'
  | 'briefRequired'
  | 'briefTooLong'
  | 'platformRequired'
  | 'autoPublishAccountRequired'
  | 'autoPublishNoMatchingAccount'
  | 'slideshowTemplateRequired'
  | 'carouselBriefRequired'
  | 'carouselThreadTooLong'
  | 'scheduleInPast'
  | 'scheduleTooFar'
  | 'scheduleNeedsAutoPublish'
  | 'scheduleNeedsAccount'
  | 'budgetRange'
  | 'ugcEnglishOnly'
  | 'ugcShortOnly'
  | 'demoRequired'
  | 'hookLineTooLong'
  | 'wallTextRequired'
  | 'wallTextTooLong';

export const MAX_BUDGET_POUNDS = 100_000;

/**
 * Problems that stop submission (empty = OK). `publishable` (20.12): the render platforms this
 * business has a connected account for, when known — it tells "pick one of your accounts" apart
 * from "none of your accounts posts to the chosen platforms". Auto-publish and scheduling work
 * the same for videos, slideshows and uploads (the API enforces the same rule:
 * automation/targets.ts assertTargetsForPolicy).
 */
export function validateCreate(
  state: CreateState,
  businessId: string | null,
  now: number = Date.now(),
  publishable?: readonly string[],
): CreateProblem[] {
  const problems: CreateProblem[] = [];
  if (state.source === 'CAROUSEL') return validateCarousel(state, businessId);
  const templated = usesTemplate(state);
  if (!businessId) problems.push('businessRequired');
  const uploading = state.source === 'UPLOAD';
  if (uploading && !state.upload) problems.push('uploadRequired');
  // 22.1: a hook + demo video needs a demo video; the brief is optional (the business profile
  // and the demo are enough). 22.2: a wall of text needs a brief or its own text block.
  const hookDemo = state.source === 'HOOK_DEMO';
  const wall = state.source === 'WALL_OF_TEXT';
  if (hookDemo) problems.push(...validateHookDemo(state.hookDemo ?? EMPTY_HOOK_DEMO));
  if (wall) problems.push(...validateWall(state));
  if (!state.brief.trim() && !templated && !uploading && !hookDemo && !wall)
    problems.push('briefRequired');
  if (state.brief.length > BRIEF_MAX) problems.push('briefTooLong');
  if (state.platforms.length === 0 && !templated) problems.push('platformRequired');
  const matching = publishable
    ? publishPlatforms(state).filter((p) => publishable.includes(p))
    : publishPlatforms(state);
  if (
    state.autoPublish &&
    buildTargets(publishPlatforms(state), state.autoPublishAccounts).length === 0
  )
    problems.push(matching.length ? 'autoPublishAccountRequired' : 'autoPublishNoMatchingAccount');
  if (state.source === 'SLIDESHOW' && !state.templateId) problems.push('slideshowTemplateRequired');
  const needsAccount = () =>
    state.autoPublish
      ? null
      : matching.length
        ? 'scheduleNeedsAutoPublish'
        : 'scheduleNeedsAccount';
  if (state.scheduleNextSlot) {
    const problem = needsAccount();
    if (problem) problems.push(problem);
  } else if (state.scheduleAt) {
    const at = Date.parse(state.scheduleAt);
    const problem = needsAccount();
    if (!Number.isFinite(at) || at <= now) problems.push('scheduleInPast');
    else if (isBeyondScheduleWindow(at, now)) problems.push('scheduleTooFar');
    else if (problem) problems.push(problem);
  }
  if (state.source === 'UGC') {
    // 21.4: actors speak English only for now, in short-form videos (ugc/validate.ts).
    const languages = [state.language || 'en-GB', ...(state.extraLanguages ?? [])];
    if (!languages.every((l) => l === 'en-GB' || l === 'en-US')) problems.push('ugcEnglishOnly');
    if (state.length !== 'short') problems.push('ugcShortOnly');
  }
  if (state.budgetPounds.trim()) {
    const value = Number(state.budgetPounds);
    if (!Number.isFinite(value) || value < 0 || value > MAX_BUDGET_POUNDS)
      problems.push('budgetRange');
  }
  return problems;
}

/** 22.1 / 22.2: the format's own settings in the POST /projects body. */
function formatFields(state: CreateState): Partial<CreateProjectBody> {
  if (state.source === 'HOOK_DEMO') {
    const choice = state.hookDemo ?? EMPTY_HOOK_DEMO;
    const hookLine = choice.hookLine.trim();
    return {
      sourceType: 'HOOK_DEMO',
      hookDemo: {
        demoUploadId: choice.demoUploadId ?? '',
        ...(hookLine && { hookLine }),
        hookSource: choice.hookSource,
        reaction: choice.reaction,
        layout: choice.layout,
        audioMix: choice.audioMix,
      },
    };
  }
  const choice = state.wallOfText ?? EMPTY_WALL_OF_TEXT;
  const text = choice.text.trim();
  return {
    sourceType: 'WALL_OF_TEXT',
    wallOfText: {
      ...(text && { text }),
      background: choice.background,
      durationSec: choice.durationSec,
    },
  };
}

function carouselBody(state: CreateState, businessId: string): CreateProjectBody {
  const rawInput = state.brief.trim();
  const thread = state.carouselThread?.trim();
  const posts = Math.min(
    CAROUSEL_POSTS_MAX,
    Math.max(CAROUSEL_POSTS_MIN, Math.round(state.carouselPosts ?? CAROUSEL_POSTS_DEFAULT)),
  );
  return {
    ...optionalName(nameFromBrief(rawInput || thread || '')),
    businessId,
    sourceType: 'CAROUSEL',
    carousel: {
      theme: state.carouselTheme ?? 'light',
      postCount: posts,
      ...(thread && { thread }),
    },
    ...(rawInput && { brief: { rawInput } }),
    ...(state.brandKitId && { brandKitId: state.brandKitId }),
    ...(state.reviewPolicy && { reviewPolicy: state.reviewPolicy }),
    ...(state.language && { language: state.language }),
    ...(state.approvalWorkflowId && { approvalWorkflowId: state.approvalWorkflowId }),
  };
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

const optionalName = (name: string | undefined) => (name?.trim() ? { name: name.trim() } : {});

export function buildCreateBody(
  state: CreateState,
  businessId: string,
  reference: Reference | null,
): CreateProjectBody {
  if (state.source === 'CAROUSEL') return carouselBody(state, businessId);
  const rawInput = state.brief.trim();
  const template = usesTemplate(state, reference) ? state.projectTemplate : null;
  const body: CreateProjectBody = {
    ...optionalName(rawInput ? nameFromBrief(rawInput) : template?.name),
    businessId,
    sourceType: 'BRIEF',
    ...(!template && { targetFormats: buildFormats(state.platforms, state.length) }),
  };
  if (state.source === 'UPLOAD' && state.upload) {
    body.sourceType = 'UPLOAD';
    body.uploadId = state.upload.id;
    if (!rawInput)
      Object.assign(
        body,
        optionalName(nameFromBrief(state.upload.fileName.replace(/\.[a-z0-9]+$/i, ''))),
      );
    if (rawInput) body.brief = { rawInput };
  } else if (state.source === 'HOOK_DEMO' || state.source === 'WALL_OF_TEXT') {
    Object.assign(body, formatFields(state));
    if (rawInput)
      body.brief = {
        rawInput,
        ...(state.targetAudience.trim() && { targetAudience: state.targetAudience.trim() }),
        ...(state.callToAction.trim() && { callToAction: state.callToAction.trim() }),
      };
    else {
      const own = state.source === 'HOOK_DEMO' ? state.hookDemo?.hookLine : state.wallOfText?.text;
      Object.assign(body, optionalName(nameFromBrief(own?.split('\n')[0] ?? '')));
    }
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
    if (state.source === 'UGC') body.ugc = ugcBody(state.ugc ?? EMPTY_UGC);
    else if (reference) {
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
  // 20.12: slideshows auto-publish and schedule exactly like videos (the API always allowed it).
  if (state.autoPublish) {
    body.publishPolicy = 'AUTO_ON_APPROVAL';
    // 15.A5: a scheduled project publishes to the same targets at the chosen time; 20.3: or,
    // with no date, at the next free posting time of the business's drip queue.
    if (state.scheduleNextSlot) {
      body.publishPolicy = 'SCHEDULED';
    } else if (state.scheduleAt) {
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
