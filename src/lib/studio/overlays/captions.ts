import type { Prisma } from '@prisma/client';
import { applyBrand, resolveStyle } from './params';
import { BUILT_IN_PRESETS } from './presets';
import type { SpokenWord } from './word-timing';

// Phase 13.5 — captions for an uploaded video: its own speech (transcribed with AssemblyAI,
// pipeline/word-timing.ts) is split into short caption lines, each shown while it is spoken,
// as editable subtitle overlays on the upload's shot.

export const CAPTION_PRESET_KEY = 'subtitle_box';
const MAX_WORDS = 7;
const MAX_SEC = 3.5;
const MIN_SEC = 0.6;
const SENTENCE_END = /[.!?…]$/;

export interface CaptionLine {
  text: string;
  startAtSec: number;
  endAtSec: number;
}

/** Group spoken words into caption lines within [0, maxEndSec). */
export function captionLines(words: SpokenWord[], maxEndSec: number): CaptionLine[] {
  const usable = words
    .filter((w) => w.text.trim() && w.startSec < maxEndSec && w.endSec > 0)
    .sort((a, b) => a.startSec - b.startSec);
  const lines: CaptionLine[] = [];
  let current: SpokenWord[] = [];
  const flush = () => {
    const first = current[0];
    const last = current.at(-1);
    if (first && last) {
      const start = Math.max(0, first.startSec);
      const end = Math.min(maxEndSec, Math.max(last.endSec, start + MIN_SEC));
      if (end > start)
        lines.push({
          text: current
            .map((w) => w.text.trim())
            .join(' ')
            .slice(0, 500),
          startAtSec: Math.round(start * 1000) / 1000,
          endAtSec: Math.round(end * 1000) / 1000,
        });
    }
    current = [];
  };
  for (const word of usable) {
    const first = current[0];
    if (first && (current.length >= MAX_WORDS || word.endSec - first.startSec > MAX_SEC)) flush();
    current.push(word);
    if (SENTENCE_END.test(word.text.trim())) flush();
  }
  flush();
  // Lines never overlap: each ends no later than the next starts.
  return lines.map((line, i) => {
    const next = lines[i + 1];
    return next && line.endAtSec > next.startAtSec
      ? { ...line, endAtSec: Math.max(line.startAtSec + 0.1, next.startAtSec) }
      : line;
  });
}

/** text_overlays rows for the caption lines of one shot. */
export function captionRows(
  shotId: string,
  lines: CaptionLine[],
  brand: { primary?: string; secondary?: string; fontFamily?: string } | null,
  presetIdByName: Map<string, string>,
): Prisma.TextOverlayCreateManyInput[] {
  const preset = BUILT_IN_PRESETS.find((p) => p.key === CAPTION_PRESET_KEY);
  if (!preset) return [];
  const base = resolveStyle(preset.parameters);
  const style = preset.brandSubstitution ? applyBrand(base, brand) : base;
  return lines.map((line, i) => ({
    shotId,
    presetId: presetIdByName.get(preset.name) ?? null,
    text: line.text,
    startAtSec: line.startAtSec,
    endAtSec: line.endAtSec,
    sortOrder: Math.min(i, 100),
    ...style,
    effect: (style.effect ?? undefined) as Prisma.InputJsonValue | undefined,
  }));
}
