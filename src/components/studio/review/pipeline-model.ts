import { parseFailure, type FailureCode } from '@/lib/client/failure-reasons';
import type { ProjectDetail } from '@/lib/client/types';

// Where the project is in the pipeline (spec 7.x states), as an ordered list of steps, and — for a
// run that stopped — which step it stopped at. Pure (no React) so the review screen and its tests
// share one reading of the project.

export type PipelineStep =
  'queued' | 'script' | 'shots' | 'render' | 'quality' | 'review' | 'publish';

export const PIPELINE_STEPS: ReadonlyArray<{ key: PipelineStep; states: readonly string[] }> = [
  { key: 'queued', states: ['QUEUED', 'SCANNING'] },
  { key: 'script', states: ['PLANNING'] },
  { key: 'shots', states: ['ASSETS_QUEUED', 'ASSETS_GENERATING'] },
  { key: 'render', states: ['RENDERING'] },
  { key: 'quality', states: ['QUALITY_CHECKING', 'QUALITY_FAILED'] },
  { key: 'review', states: ['READY_FOR_REVIEW', 'REJECTED', 'APPROVED'] },
  { key: 'publish', states: ['PUBLISHING', 'PARTIALLY_PUBLISHED', 'PUBLISHED'] },
];

/** Index of the current step; -1 before the run starts (DRAFT) or when it failed. */
export function stepIndex(state: string): number {
  return PIPELINE_STEPS.findIndex((s) => s.states.includes(state));
}

/**
 * done: finished · current: working on it now · attention: waiting on a person (rejected,
 * partly published) · failed: the run stopped here · todo: not reached.
 */
export type StepStatus = 'done' | 'current' | 'attention' | 'failed' | 'todo';

export type PipelinePhase = 'draft' | 'running' | 'waiting' | 'failed' | 'complete' | 'idle';

export interface PipelineView {
  phase: PipelinePhase;
  steps: ReadonlyArray<{ key: PipelineStep; status: StepStatus }>;
  /** The step a failed run stopped at (null unless phase is "failed"). */
  failedStep: PipelineStep | null;
}

/** The failure codes whose step is known from the code alone. */
const STEP_OF_CODE: Partial<Record<FailureCode, PipelineStep>> = {
  restricted_topics: 'script',
  brief_too_vague: 'script',
  script_safety_block: 'script',
  script_safety_review: 'script',
  script_safety_blocked_by_review: 'script',
  planning_failed: 'script',
  slideshow_incomplete: 'script',
  carousel_incomplete: 'script',
  upload_missing: 'script',
  script_regenerate_failed: 'script',
  ugc_real_person_refused: 'script',
  wall_of_text_invalid: 'script',
  asset_generation_failed: 'shots',
  no_demo_video: 'shots',
  hook_clip_unavailable: 'shots',
  no_background_video: 'shots',
  composition_failed: 'render',
  carousel_render_error: 'render',
  quality_failed: 'quality',
  quality_gate_error: 'quality',
  content_safety_block: 'quality',
  content_safety_blocked_by_review: 'quality',
  rejected: 'review',
  scheduling_failed: 'publish',
  youtube_quota_deferred: 'publish',
};

type FailureInput = Pick<ProjectDetail, 'state' | 'errorReason' | 'scripts' | 'renders'>;

/** How far the run's own data got: no script → script, unfinished shots → shots, and so on. */
function stepFromData(project: FailureInput): PipelineStep {
  if (project.scripts.length === 0) return 'script';
  const shots = project.scripts.flatMap((s) => s.shots);
  if (shots.some((s) => s.state !== 'READY')) return 'shots';
  return project.renders.length === 0 ? 'render' : 'quality';
}

/**
 * The step a stopped run (FAILED, cancelled, paused by a limit) stopped at: from the stored
 * failure code when it names a step, otherwise from how far the run's scripts, shots and renders
 * got (a provider outage, a cancel, a limit pause).
 */
export function failedStepOf(project: FailureInput): PipelineStep {
  if (project.state === 'QUALITY_FAILED') return 'quality';
  const code = parseFailure(project.errorReason)?.code;
  const known = code ? STEP_OF_CODE[code] : undefined;
  return known ?? stepFromData(project);
}

const WAITING = new Set(['REJECTED', 'PARTIALLY_PUBLISHED']);

export function pipelineView(project: FailureInput): PipelineView {
  const { state } = project;
  if (state === 'DRAFT')
    return {
      phase: 'draft',
      steps: PIPELINE_STEPS.map((s) => ({ key: s.key, status: 'todo' })),
      failedStep: null,
    };
  if (state === 'FAILED' || state === 'QUALITY_FAILED') {
    const failedStep = failedStepOf(project);
    const at = PIPELINE_STEPS.findIndex((s) => s.key === failedStep);
    return {
      phase: 'failed',
      steps: PIPELINE_STEPS.map((s, i) => ({
        key: s.key,
        status: i < at ? 'done' : i === at ? 'failed' : 'todo',
      })),
      failedStep,
    };
  }
  const current = stepIndex(state);
  if (current < 0)
    return {
      phase: 'idle',
      steps: PIPELINE_STEPS.map((s) => ({ key: s.key, status: 'todo' })),
      failedStep: null,
    };
  const complete = state === 'PUBLISHED';
  const waiting = WAITING.has(state);
  const settled = complete || state === 'READY_FOR_REVIEW' || state === 'APPROVED';
  return {
    phase: complete ? 'complete' : waiting ? 'waiting' : settled ? 'idle' : 'running',
    steps: PIPELINE_STEPS.map((s, i) => ({
      key: s.key,
      status:
        complete || i < current
          ? 'done'
          : i === current
            ? waiting
              ? 'attention'
              : 'current'
            : 'todo',
    })),
    failedStep: null,
  };
}
