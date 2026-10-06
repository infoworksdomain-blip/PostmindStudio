import { ConfigurationError } from '../../errors';

// BACKLOG 23.2 (operator request 2026-10-06, pipeline speed) — per-task Claude model routing.
// Production (2026-10-06, 3 days): every Claude call used the one ANTHROPIC_MODEL (Sonnet), p50
// 6.4 s / p90 18.5 s, 66–86 s of Claude time per AI or UGC video. Short, high-volume calls (yes/no
// checks, captions, one-line copy) do not need the planning model, so each call site names its
// TASK and the task picks the model:
//   - "standard" tasks (the creative planning: ideation, scripts, Blitz card writing, month plans,
//     carousel threads, slideshow text, website and library analysis) stay on ANTHROPIC_MODEL;
//   - "light" tasks use ANTHROPIC_LIGHT_MODEL, Claude Haiku 4.5 by default.
// ANTHROPIC_TASK_MODELS="task=model,task=model" overrides single tasks (e.g. put script_safety back
// on Sonnet). Every model must have a price row (anthropic-models.ts) or the worker fails at start.
// A request without a task is a standard task.

export const TEXT_TASKS = [
  // standard
  'ideation',
  'script',
  'blitz_cards',
  'month_plan',
  'carousel_thread',
  'slideshow_text',
  'business_profile',
  'library_analysis',
  // light
  'script_safety',
  'post_copy',
  'hook_line',
  'wall_text',
  'blitz_angles',
  'clip_text_check',
] as const;

export type TextTask = (typeof TEXT_TASKS)[number];
export type TextTaskTier = 'standard' | 'light';

/** Which model tier each task uses (the per-call-site choice; tested in text-tasks.test.ts). */
export const TEXT_TASK_TIER: Readonly<Record<TextTask, TextTaskTier>> = {
  ideation: 'standard',
  script: 'standard',
  blitz_cards: 'standard',
  month_plan: 'standard',
  carousel_thread: 'standard',
  slideshow_text: 'standard',
  business_profile: 'standard',
  library_analysis: 'standard',
  // Pre-generation safety verdict over finished scripts (and the UGC real-person check is part
  // of it: ideation flags realPersonRequested, ugc/real-person.ts is a word list).
  script_safety: 'light',
  // Captions + hashtags per platform, fitted afterwards by caption-suggestions.ts.
  post_copy: 'light',
  // 22.1 / 22.2: one hook line (≤ 9 words) and one wall-of-text block.
  hook_line: 'light',
  wall_text: 'light',
  // Blitz angle suggestions (titles + one line each); the cards themselves stay standard.
  blitz_angles: 'light',
  // 21.4c: "is there burned-in text in these frames" yes/no per frame.
  clip_text_check: 'light',
};

/** Claude Haiku 4.5 (platform.claude.com/docs/en/about-claude/models/overview, read 2026-10-06). */
export const DEFAULT_LIGHT_MODEL = 'claude-haiku-4-5-20251001';

export const LIGHT_MODEL_ENV = 'ANTHROPIC_LIGHT_MODEL';
export const TASK_MODELS_ENV = 'ANTHROPIC_TASK_MODELS';

export interface TextModelMap {
  standard: string;
  light: string;
  overrides: Readonly<Partial<Record<TextTask, string>>>;
}

export function isTextTask(value: string): value is TextTask {
  return (TEXT_TASKS as readonly string[]).includes(value);
}

/** The model a task runs on (no task = standard). */
export function modelForTask(map: TextModelMap, task: TextTask | undefined): string {
  if (!task) return map.standard;
  return map.overrides[task] ?? (TEXT_TASK_TIER[task] === 'light' ? map.light : map.standard);
}

/** Every model the map can choose (for price checks). */
export function modelsOf(map: TextModelMap): string[] {
  return [...new Set([map.standard, map.light, ...Object.values(map.overrides)])].filter(
    (m): m is string => typeof m === 'string',
  );
}

/** ANTHROPIC_TASK_MODELS: "task=model[,task=model…]" (empty = none). */
export function parseTaskModels(raw: string | undefined): Partial<Record<TextTask, string>> {
  const value = raw?.trim();
  if (!value) return {};
  const out: Partial<Record<TextTask, string>> = {};
  for (const part of value.split(',')) {
    const match = /^\s*([a-z_]+)\s*=\s*([A-Za-z0-9._-]+)\s*$/.exec(part);
    const task = match?.[1];
    const model = match?.[2];
    if (!task || !model || !isTextTask(task)) {
      throw new ConfigurationError(
        `${TASK_MODELS_ENV} must be "task=model,…" with tasks from: ${TEXT_TASKS.join(', ')}`,
      );
    }
    out[task] = model;
  }
  return out;
}

/**
 * The task → model map from the environment. `standard` is ANTHROPIC_MODEL (or the adapter's
 * default); ANTHROPIC_LIGHT_MODEL="off" keeps light tasks on the standard model.
 */
export function textModelsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  defaultStandard: string,
): TextModelMap {
  const standard = env.ANTHROPIC_MODEL?.trim() || defaultStandard;
  const lightRaw = env[LIGHT_MODEL_ENV]?.trim();
  const light = !lightRaw ? DEFAULT_LIGHT_MODEL : lightRaw === 'off' ? standard : lightRaw;
  return { standard, light, overrides: parseTaskModels(env[TASK_MODELS_ENV]) };
}
