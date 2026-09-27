import type { Prisma } from '@prisma/client';
import { applyBrand, resolveStyle, type OverlayStyle } from './params';
import { BUILT_IN_PRESETS, ROLE_PRESET } from './presets';

// BACKLOG 8.5 / Addendum A4.5 — when Layer 2 produces a script, every shot's onScreenText
// becomes a proposed overlay with a preset chosen by the shot's role: first shot → hook,
// last shot → call to action, others → subtitle. TEXT_CARD shots already show their text.

export interface SuggestShot {
  id: string;
  sortOrder: number;
  durationSec: number;
  onScreenText: string | null;
  visualTreatment: string;
}

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
): SuggestedOverlay[] {
  const ordered = [...shots].sort((a, b) => a.sortOrder - b.sortOrder);
  return ordered.flatMap((shot, index) => {
    const text = shot.onScreenText?.trim();
    if (!text || shot.visualTreatment === 'TEXT_CARD') return [];
    const preset = BUILT_IN_PRESETS.find(
      (p) => p.key === ROLE_PRESET[shotRole(index, ordered.length)],
    );
    if (!preset) return [];
    const base = resolveStyle(preset.parameters);
    return [
      {
        shotId: shot.id,
        text: text.slice(0, 500),
        startAtSec: 0,
        endAtSec: Math.max(0.5, shot.durationSec),
        style: preset.brandSubstitution ? applyBrand(base, brand) : base,
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
