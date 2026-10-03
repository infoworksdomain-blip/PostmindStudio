import type { IdeationResult } from './ideation';

// BACKLOG 20.18 — the "brief too vague" loop.
//
// Ideation may answer actionable=false with three direction options. The project then rests in
// DRAFT with VAGUE_BRIEF_REASON and metadata.directionOptions, the project page shows the options,
// and the owner picks one (or rewrites the brief): generate then runs with
// metadata.directionChosen. Ideation is never allowed to say "too vague" twice in a row
// (metadata.lastBriefVague): the second answer is turned into a brief here instead.

/** The project's errorReason while it waits for the owner to choose a direction. */
export const VAGUE_BRIEF_REASON = 'brief_too_vague: choose one of the suggested directions';

/** At most this many directions are stored and shown. */
export const MAX_DIRECTION_OPTIONS = 3;
/** A direction longer than this is cut (it is resent as the brief, max 4,000 characters). */
export const MAX_DIRECTION_CHARS = 500;

/** True for a stored reason that means "choose a direction" (the code, with or without text). */
export function isVagueBriefReason(reason: string | null | undefined): boolean {
  return /^brief_too_vague(?::|$)/.test(reason?.trim() ?? '');
}

/** The direction options in stored metadata (or a model answer), cleaned: strings, trimmed, ≤ 3. */
export function directionOptionsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.replace(/\s+/g, ' ').trim().slice(0, MAX_DIRECTION_CHARS))
    .filter(Boolean)
    .slice(0, MAX_DIRECTION_OPTIONS);
}

export interface ForcedBriefFallback {
  /** The owner's brief text (what they typed or chose). */
  briefText: string;
  /** The owner's audience hint or the brand kit's audience, if any. */
  audience?: string | null;
  /** The brand kit's tone keywords, if any. */
  toneKeywords?: readonly string[];
}

const FALLBACK_AUDIENCE = "the business's customers";
const FALLBACK_TONE = 'warm, clear, confident';
const HOOK_CHARS = 200;

/**
 * 20.18: ideation said "too vague" although the owner has already chosen a direction (or was
 * asked on the previous run). Asking again would be a dead end, so the answer becomes a brief:
 * the model's own fields where it wrote them, else the first suggested direction or the owner's
 * text. Deterministic and free (no second model call).
 */
export function forceActionable(
  brief: IdeationResult,
  fallback: ForcedBriefFallback,
): IdeationResult {
  if (brief.actionable) return brief;
  const direction =
    directionOptionsOf(brief.directionOptions)[0] ?? fallback.briefText.replace(/\s+/g, ' ').trim();
  const tone = (fallback.toneKeywords ?? []).filter(Boolean).join(', ');
  return {
    ...brief,
    actionable: true,
    directionOptions: [],
    hook: brief.hook.trim() || direction.slice(0, HOOK_CHARS),
    keyMessage: brief.keyMessage.trim() || direction,
    targetAudience: brief.targetAudience.trim() || fallback.audience?.trim() || FALLBACK_AUDIENCE,
    tone: brief.tone.trim() || tone || FALLBACK_TONE,
  };
}
