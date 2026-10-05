import type { Prisma } from '@prisma/client';
import { applyBrand, resolveStyle, type OverlayStyle } from './params';
import { BUILT_IN_PRESETS, ROLE_PRESET } from './presets';
import { showsOwnText } from './voice-captions';

// BACKLOG 8.5 / Addendum A4.5 — when Layer 2 produces a script, every shot's onScreenText
// becomes a proposed overlay with a preset chosen by the shot's role: first shot → hook,
// last shot → call to action, others → subtitle. TEXT_CARD shots already show their text.

export interface SuggestShot {
  id: string;
  sortOrder: number;
  durationSec: number;
  onScreenText: string | null;
  visualTreatment: string;
  /** The shot's narration; a voiced shot gets burned-in captions in the lower third. */
  voiceoverText?: string | null;
}

/**
 * Where a voiced shot's body or CTA label sits: the upper area, clear of the burned-in narration
 * captions (voice-captions.ts, anchorY 0.7) and below the AI label and platform top bar. Production
 * QA run 10 (2026-10-04): subtitle-box labels at 0.78 overlapped those captions.
 */
export const VOICED_LABEL_ANCHOR_Y = 0.2;

/**
 * BACKLOG 21.4a (production 2026-10-04): a UGC actor clip is a selfie, so 0.2 is over the actor's
 * face ("dreaded client calls" sat on it). Actor shots get no suggested labels (their words are
 * burned-in captions at 0.7); only the opening hook keeps a short, smaller label in the top band:
 * below the AI-generated label (pipeline/ai-label.ts: top, about 2–6% down) and above the face.
 */
export const UGC_HOOK_ANCHOR_Y = 0.11;
/** The UGC hook label's size (the hook preset's 5% would reach the face on two lines). */
export const UGC_HOOK_FONT_PCT = 3.6;
/** A longer hook would wrap down onto the face: it is left to the captions instead. */
export const UGC_HOOK_MAX_CHARS = 40;

export type ShotRole = 'hook' | 'body' | 'cta';

export function shotRole(index: number, count: number): ShotRole {
  if (index === 0) return 'hook';
  if (count > 1 && index === count - 1) return 'cta';
  return 'body';
}

export interface SuggestedOverlay {
  shotId: string;
  text: string;
  startAtSec: number;
  endAtSec: number;
  style: OverlayStyle;
  presetName: string;
}

export function suggestOverlays(
  shots: SuggestShot[],
  brand: { primary?: string; secondary?: string; fontFamily?: string } | null,
  /** Preset key per shot index (e.g. from a TEMPLATE reference); null falls back to the role. */
  presetForShot?: (index: number) => string | null,
): SuggestedOverlay[] {
  const ordered = [...shots].sort((a, b) => a.sortOrder - b.sortOrder);
  return ordered.flatMap((shot, index) => {
    const text = shot.onScreenText?.trim();
    // Text and motion-graphics cards draw their own text; a label would repeat it (QA run 10).
    if (!text || showsOwnText(shot.visualTreatment)) return [];
    const role = shotRole(index, ordered.length);
    // 21.4a: no label over an actor's face; only the opening hook, small, in the top band.
    const actor = shot.visualTreatment === 'UGC_ACTOR';
    if (actor && (role !== 'hook' || text.length > UGC_HOOK_MAX_CHARS)) return [];
    const key = actor ? ROLE_PRESET.hook : (presetForShot?.(index) ?? ROLE_PRESET[role]);
    const preset = BUILT_IN_PRESETS.find((p) => p.key === key);
    if (!preset) return [];
    const base = resolveStyle(preset.parameters);
    const branded = preset.brandSubstitution ? applyBrand(base, brand) : base;
    const voiced = Boolean(shot.voiceoverText?.trim());
    const style = actor
      ? { ...branded, anchorY: UGC_HOOK_ANCHOR_Y, fontSizePct: UGC_HOOK_FONT_PCT }
      : voiced && role !== 'hook'
        ? { ...branded, anchorY: VOICED_LABEL_ANCHOR_Y }
        : branded;
    return [
      {
        shotId: shot.id,
        text: text.slice(0, 500),
        startAtSec: 0,
        endAtSec: Math.max(0.5, shot.durationSec),
        style,
        presetName: preset.name,
      },
    ];
  });
}

/** Rows for text_overlays; presetId resolves the seeded built-in by name when present. */
export function suggestionRows(
  suggestions: SuggestedOverlay[],
  presetIdByName: Map<string, string>,
): Prisma.TextOverlayCreateManyInput[] {
  return suggestions.map((s) => ({
    shotId: s.shotId,
    presetId: presetIdByName.get(s.presetName) ?? null,
    text: s.text,
    startAtSec: s.startAtSec,
    endAtSec: s.endAtSec,
    ...s.style,
    effect: (s.style.effect ?? undefined) as Prisma.InputJsonValue | undefined,
  }));
}
