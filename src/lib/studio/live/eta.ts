// BACKLOG 24.2 — live status for calendar / month-plan / Blitz cards: which stage a post is in
// ("Planning", "Making clips", "Composing", "Ready", "Scheduled", "Posted", "Failed"), how far
// along it probably is and roughly how long is left. Pure and browser-safe (no Prisma import):
// the SSE route computes it per event and the chips re-compute it every few seconds so the ETA
// counts down between events.

export const LIVE_FORMATS = [
  'carousel',
  'wall_of_text',
  'slideshow',
  'hook_demo',
  'ugc',
  'ai_video',
] as const;
export type LiveFormat = (typeof LIVE_FORMATS)[number];

/**
 * Median (p50) seconds from "generate" to READY_FOR_REVIEW per format, measured on production
 * 2026-10-06 (operator's speed plan, "faster and better than Fastlane"). One place on purpose:
 * re-measure and update these together.
 */
export const FORMAT_P50_SECONDS: Readonly<Record<LiveFormat, number>> = {
  carousel: 26,
  wall_of_text: 81,
  slideshow: 112,
  hook_demo: 135,
  ugc: 230,
  ai_video: 431,
};

export const LIVE_STAGES = [
  'planning',
  'making_clips',
  'composing',
  'ready',
  'scheduled',
  'posted',
  'failed',
] as const;
export type LiveStage = (typeof LIVE_STAGES)[number];

/** Stages in which the post is still being made (progress and ETA apply). */
export const IN_PROGRESS_STAGES: ReadonlySet<LiveStage> = new Set([
  'planning',
  'making_clips',
  'composing',
]);

/** The share of the run each in-progress stage covers (floor, ceiling) in percent. */
const STAGE_BANDS: Readonly<Record<'planning' | 'making_clips' | 'composing', [number, number]>> = {
  planning: [2, 20],
  making_clips: [20, 80],
  composing: [80, 97],
};

const PROJECT_STAGE: Readonly<Record<string, LiveStage>> = {
  QUEUED: 'planning',
  SCANNING: 'planning',
  PLANNING: 'planning',
  ASSETS_QUEUED: 'making_clips',
  ASSETS_GENERATING: 'making_clips',
  RENDERING: 'composing',
  QUALITY_CHECKING: 'composing',
  READY_FOR_REVIEW: 'ready',
  APPROVED: 'ready',
  PUBLISHING: 'scheduled',
  PUBLISHED: 'posted',
  PARTIALLY_PUBLISHED: 'posted',
  QUALITY_FAILED: 'failed',
  REJECTED: 'failed',
  FAILED: 'failed',
};

const PUBLICATION_STAGE: Readonly<Record<string, LiveStage>> = {
  SCHEDULED: 'scheduled',
  PUBLISHING: 'scheduled',
  PUBLISHED: 'posted',
  FAILED: 'failed',
};

/**
 * The chip stage of a project (DRAFT / ARCHIVED → null: no chip). A publication's own state wins
 * once the project is made: a calendar card is one post on one network.
 */
export function liveStageOf(
  projectState: string,
  publicationState?: string | null,
): LiveStage | null {
  const fromProject = PROJECT_STAGE[projectState] ?? null;
  if (fromProject && IN_PROGRESS_STAGES.has(fromProject)) return fromProject;
  if (publicationState && PUBLICATION_STAGE[publicationState])
    return PUBLICATION_STAGE[publicationState];
  return fromProject;
}

/**
 * The format of a project from its own fields (blitz/formats.ts keys): the source type, and a
 * BRIEF project with metadata.ugc is a UGC video. Uploads and unknown sources have no estimate.
 */
export function liveFormatOf(project: {
  sourceType: string;
  metadata?: unknown;
}): LiveFormat | null {
  switch (project.sourceType) {
    case 'CAROUSEL':
      return 'carousel';
    case 'WALL_OF_TEXT':
      return 'wall_of_text';
    case 'SLIDESHOW':
      return 'slideshow';
    case 'HOOK_DEMO':
      return 'hook_demo';
    case 'BRIEF':
    case 'POSTMIND_CONTENT':
    case 'TEMPLATE':
    case 'LIBRARY_REFERENCE': {
      const meta = project.metadata;
      const ugc =
        meta !== null && typeof meta === 'object' && !Array.isArray(meta) && 'ugc' in meta;
      return ugc ? 'ugc' : 'ai_video';
    }
    default:
      return null;
  }
}

export interface LiveEstimate {
  /** 0–100, null when the post is not being made or the format has no estimate. */
  progressPct: number | null;
  /** Seconds left (0 = "finishing"), null when there is no estimate. */
  etaSec: number | null;
}

const NO_ESTIMATE: LiveEstimate = { progressPct: null, etaSec: null };

/**
 * Progress and time left from the format's p50, the run's start and the stage: elapsed / p50,
 * kept inside the stage's band (a run that is already composing is at least 80 % done even when
 * it started a while ago, and never shows 100 % before it is ready).
 */
export function estimateLive(input: {
  stage: LiveStage | null;
  format: LiveFormat | null;
  startedAtMs: number | null;
  nowMs: number;
}): LiveEstimate {
  const { stage, format } = input;
  if (!stage || !IN_PROGRESS_STAGES.has(stage) || !format) return NO_ESTIMATE;
  const p50 = FORMAT_P50_SECONDS[format];
  const [floor, ceiling] = STAGE_BANDS[stage as keyof typeof STAGE_BANDS];
  const elapsedSec =
    input.startedAtMs === null ? null : Math.max(0, (input.nowMs - input.startedAtMs) / 1000);
  const timePct = elapsedSec === null ? floor : (elapsedSec / p50) * 100;
  const pct = Math.min(ceiling, Math.max(floor, timePct));
  const progressPct = Math.round(pct);
  const leftByTime = elapsedSec === null ? Infinity : p50 - elapsedSec;
  const leftByStage = p50 * (1 - pct / 100);
  const etaSec = Math.max(0, Math.round(Math.min(leftByTime, leftByStage)));
  return { progressPct, etaSec };
}

/** Whole minutes to show for an ETA ("~2 min"); at least 1 while time is left. */
export function etaMinutes(etaSec: number): number {
  return Math.max(1, Math.ceil(etaSec / 60));
}
