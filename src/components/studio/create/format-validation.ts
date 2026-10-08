import {
  CAROUSEL_THREAD_MAX,
  countWords,
  HOOK_LINE_MAX_WORDS,
  WALL_TEXT_MAX_LINES,
  WALL_TEXT_MAX_WORDS,
  type HookDemoChoice,
} from './format-choices';
import { BRIEF_MAX, type CreateProblem, type CreateState } from './body';

// The per-format checks validateCreate (body.ts) runs: hook + demo (22.1), wall of text (22.2)
// and carousels (21.6), mirroring the API's limits.

export function validateHookDemo(choice: HookDemoChoice): CreateProblem[] {
  return [
    ...(choice.demoUploadId ? [] : (['demoRequired'] as const)),
    ...(countWords(choice.hookLine) > HOOK_LINE_MAX_WORDS ? (['hookLineTooLong'] as const) : []),
  ];
}

export function validateWall(state: CreateState): CreateProblem[] {
  const text = state.wallOfText?.text ?? '';
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  return [
    ...(!state.brief.trim() && !text.trim() ? (['wallTextRequired'] as const) : []),
    ...(countWords(text) > WALL_TEXT_MAX_WORDS || lines > WALL_TEXT_MAX_LINES
      ? (['wallTextTooLong'] as const)
      : []),
  ];
}

/**
 * 21.6: a carousel needs a brief or a pasted thread; it has no platforms, length or budget to
 * choose (it is published, and its networks picked, from the carousel editor).
 */
export function validateCarousel(state: CreateState, businessId: string | null): CreateProblem[] {
  const problems: CreateProblem[] = [];
  if (!businessId) problems.push('businessRequired');
  if (!state.brief.trim() && !state.carouselThread?.trim()) problems.push('carouselBriefRequired');
  if (state.brief.length > BRIEF_MAX) problems.push('briefTooLong');
  if ((state.carouselThread?.length ?? 0) > CAROUSEL_THREAD_MAX)
    problems.push('carouselThreadTooLong');
  return problems;
}
