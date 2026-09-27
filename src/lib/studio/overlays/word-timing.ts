// Phase 13.6 — word-level karaoke timing. Narration is transcribed with AssemblyAI after Layer 4
// (pipeline/word-timing.ts); its `words[]` carry start/end in milliseconds, converted to seconds
// by the adapter (https://www.assemblyai.com/docs/speech-to-text/pre-recorded-audio/word-level-timestamps,
// read 2026-09-27). Here the overlay's words are aligned to those spoken words so each word
// lights up when it is said, instead of being spread evenly across the overlay.

export interface SpokenWord {
  text: string;
  startSec: number;
  endSec: number;
}

/** Lower-case letters and digits only, so "Bread," matches "bread". */
export function normaliseWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Spoken words from untrusted JSON (asset metadata). */
export function parseSpokenWords(value: unknown): SpokenWord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((w) => {
    if (!w || typeof w !== 'object') return [];
    const { text, startSec, endSec } = w as Record<string, unknown>;
    return typeof text === 'string' &&
      typeof startSec === 'number' &&
      typeof endSec === 'number' &&
      Number.isFinite(startSec) &&
      Number.isFinite(endSec)
      ? [{ text, startSec, endSec }]
      : [];
  });
}

const LOOKAHEAD = 6;
const MIN_MATCH_RATIO = 0.5;

/**
 * Highlight time (seconds from the overlay's start) for each word of `text`, from the spoken
 * words of the shot (times from the shot's start). Words are matched in order with a short
 * look-ahead; unmatched words are interpolated between their matched neighbours. Returns null
 * when fewer than half the words match (the caller spreads words evenly instead).
 */
export function alignKaraoke(
  text: string,
  spoken: SpokenWord[],
  overlayStartSec: number,
  overlayEndSec: number,
): number[] | null {
  const words = text.split(/\s+/).filter(Boolean);
  const duration = overlayEndSec - overlayStartSec;
  if (words.length === 0 || spoken.length === 0 || duration <= 0) return null;
  const inWindow = spoken.filter(
    (w) => w.endSec > overlayStartSec - 0.05 && w.startSec < overlayEndSec,
  );
  const times: Array<number | null> = [];
  let cursor = 0;
  for (const word of words) {
    const key = normaliseWord(word);
    let found = -1;
    for (let j = cursor; j < Math.min(inWindow.length, cursor + LOOKAHEAD); j += 1) {
      if (key && normaliseWord(inWindow[j]?.text ?? '') === key) {
        found = j;
        break;
      }
    }
    if (found >= 0) {
      times.push((inWindow[found]?.startSec ?? 0) - overlayStartSec);
      cursor = found + 1;
    } else {
      times.push(null);
    }
  }
  const matched = times.filter((t) => t !== null).length;
  if (matched / words.length < MIN_MATCH_RATIO) return null;
  return fillGaps(times, duration);
}

function fillGaps(times: Array<number | null>, duration: number): number[] {
  const clamp = (t: number) => Math.min(Math.max(0, t), Math.max(0, duration - 0.001));
  const out: number[] = [];
  for (let i = 0; i < times.length; i += 1) {
    const known = times[i];
    if (known !== null && known !== undefined) {
      out.push(clamp(known));
      continue;
    }
    const prevIndex = out.length - 1;
    const prev = prevIndex >= 0 ? (out[prevIndex] ?? 0) : 0;
    let nextIndex = i + 1;
    while (nextIndex < times.length && times[nextIndex] == null) nextIndex += 1;
    const next = nextIndex < times.length ? (times[nextIndex] ?? duration) : duration;
    const span = nextIndex - prevIndex;
    out.push(clamp(prev + ((next - prev) * (i - prevIndex)) / Math.max(1, span)));
  }
  // Highlights never go backwards.
  for (let i = 1; i < out.length; i += 1) out[i] = Math.max(out[i] ?? 0, out[i - 1] ?? 0);
  return out.map((t) => Math.round(t * 1000) / 1000);
}
