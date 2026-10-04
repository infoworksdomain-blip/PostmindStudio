import type { Prisma, VisualTreatment } from '@prisma/client';
import { languageOf } from '../languages';
import type { SpokenWord } from '../overlays/word-timing';

// BACKLOG 15.B3 — spec 5.5: "Voice pace is tuned to the shot duration ± 5%; if the voiceover
// exceeds the shot, either the shot is extended or the voiceover is trimmed automatically", and
// "one of five pre-selected ElevenLabs voices matched to the brand's declared tone".
//
// Fit, after TTS (generate-asset.ts):
//   1. measure the narration: the end of the last spoken word (13.6 word timing), else the
//      file's probed duration;
//   2. ends inside the shot (FIT_SLACK_SEC of rounding allowed) → nothing to do. The ±5% is the
//      pace target, not a licence to overrun: the composer stops the voice clip at the shot end,
//      so a 3.09 s line in a 3.00 s shot lost its last word and failed audio_sync (2026-10-04);
//      any longer narration goes to steps 3–5;
//   3. a shot whose picture can simply stay on screen longer (still image, text card, motion
//      card) is extended, while the script stays inside the ±2 s duration check;
//   4. otherwise the narration is regenerated faster with ElevenLabs voice_settings.speed
//      (documented, max 1.2), once;
//   5. otherwise it is trimmed at the last word that ends inside the shot (or at the shot end
//      when there is no word timing) and the composer stops the voice clip there.

export const FIT_TOLERANCE = 0.05;
/**
 * How far narration may run past its shot and still count as fitting: the same margin
 * quality-sync.ts allows between the narration and its voice clip on the timeline.
 */
export const FIT_SLACK_SEC = 0.05;
/** ElevenLabs' documented maximum speaking rate (providers/elevenlabs.ts MAX_SPEED). */
export const MAX_FIT_SPEED = 1.2;
/** Head-room kept after the last word when a shot is extended or narration trimmed. */
export const TAIL_SEC = 0.2;
export const EXTENDABLE_TREATMENTS: ReadonlySet<VisualTreatment> = new Set<VisualTreatment>([
  'IMAGE_STILL',
  'TEXT_CARD',
  'MOTION_GRAPHICS',
]);

export type FitStrategy = 'fits' | 'extend' | 'speed' | 'trim' | 'unmeasured';

export interface FitDecision {
  strategy: FitStrategy;
  voiceSec: number | null;
  shotSec: number;
  /** extend: the shot's new length. */
  newShotSec?: number;
  /** speed: the rate to regenerate at. */
  speed?: number;
  /** trim: where the voice clip stops (seconds from the shot start). */
  trimSec?: number;
  /** trim: whether the cut falls on a word boundary (false = no word timing). */
  wordBoundary?: boolean;
  /** The narration was regenerated faster before this decision. */
  speedApplied?: boolean;
}

/** How long the narration actually speaks for. */
export function narrationSec(words: SpokenWord[], probedSec: number | null): number | null {
  const last = words.reduce((max, w) => Math.max(max, w.endSec), 0);
  if (last > 0) return last;
  return probedSec !== null && probedSec > 0 ? probedSec : null;
}

/** Stop point at the last word ending inside the shot, or null when no word does. */
export function trimAtWordBoundary(words: SpokenWord[], shotSec: number): number | null {
  const inside = words.filter((w) => w.endSec <= shotSec - 0.05);
  const last = inside.reduce((max, w) => Math.max(max, w.endSec), 0);
  return last > 0 ? Math.min(shotSec, Math.round((last + 0.05) * 1000) / 1000) : null;
}

export function decideFit(input: {
  voiceSec: number | null;
  shotSec: number;
  treatment: VisualTreatment;
  words: SpokenWord[];
  /** Seconds the script may still grow by and stay inside the duration check. */
  extendBudgetSec: number;
  /** The narration came from a provider with a documented rate control (ElevenLabs). */
  canSpeedUp: boolean;
  /** This narration was already regenerated faster once. */
  alreadySped: boolean;
}): FitDecision {
  const { voiceSec, shotSec } = input;
  if (voiceSec === null) return { strategy: 'unmeasured', voiceSec, shotSec };
  if (voiceSec <= shotSec + FIT_SLACK_SEC) return { strategy: 'fits', voiceSec, shotSec };
  const newShotSec = Math.ceil((voiceSec + TAIL_SEC) * 10) / 10;
  if (EXTENDABLE_TREATMENTS.has(input.treatment) && newShotSec - shotSec <= input.extendBudgetSec)
    return { strategy: 'extend', voiceSec, shotSec, newShotSec };
  const speed = Math.ceil((voiceSec / shotSec) * 1.02 * 100) / 100;
  if (input.canSpeedUp && !input.alreadySped && speed <= MAX_FIT_SPEED)
    return { strategy: 'speed', voiceSec, shotSec, speed };
  const atWord = trimAtWordBoundary(input.words, shotSec);
  return {
    strategy: 'trim',
    voiceSec,
    shotSec,
    trimSec: atWord ?? shotSec,
    wordBoundary: atWord !== null,
  };
}

/** metadata.fit.trimSec of a narration asset (the composer's voice clip length), or null. */
export function voiceTrimSecOf(metadata: Prisma.JsonValue | null): number | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const fit = (metadata as Record<string, unknown>).fit;
  if (!fit || typeof fit !== 'object' || Array.isArray(fit)) return null;
  const trim = (fit as Record<string, unknown>).trimSec;
  return typeof trim === 'number' && Number.isFinite(trim) && trim > 0 ? trim : null;
}

/** metadata.fit of a narration asset, or null. */
export function fitOf(metadata: Prisma.JsonValue | null): FitDecision | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const fit = (metadata as Record<string, unknown>).fit;
  return fit && typeof fit === 'object' && !Array.isArray(fit) ? (fit as FitDecision) : null;
}

// ---------------------------------------------------------------------------------------------
// Tone-matched stock voices (STUDIO_STOCK_VOICES).
//
// Format: comma-separated `tone=voiceId` pairs, e.g.
//   warm=21m00Tcm4TlvDq8ikWAM,energetic=…,professional=…,playful=…,calm=…
// A pair may be limited to one language with `tone@lang=voiceId` (e.g. `warm@fr=…`); it wins
// over the plain pair for scripts in that language. Voice ids come from the operator's ElevenLabs
// voice library (GET /v1/voices); Studio never guesses them.

export type StockVoiceMap = ReadonlyMap<string, string>;

const TONE = /^[a-z][a-z -]{0,39}$/;
const VOICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseStockVoices(raw: string | undefined): StockVoiceMap {
  const map = new Map<string, string>();
  for (const pair of (raw ?? '').split(',')) {
    const [key, voiceId] = pair.split('=').map((v) => v?.trim() ?? '');
    if (!key || !voiceId || !VOICE_ID.test(voiceId)) continue;
    const [tone, lang] = key.toLowerCase().split('@');
    if (!tone || !TONE.test(tone)) continue;
    map.set(lang ? `${tone}@${languageOf(lang).base}` : tone, voiceId);
  }
  return map;
}

/**
 * The stock voice for a brand's tone keywords: the first keyword (in the kit's order) that names
 * a configured tone, preferring a voice set for the script's language. Keywords match a tone
 * exactly or as a whole word ("warm and friendly" → warm). Null = none configured / no match.
 */
export function selectStockVoice(
  toneKeywords: string[],
  language: string | null | undefined,
  voices: StockVoiceMap,
): string | null {
  if (voices.size === 0) return null;
  const base = languageOf(language).base;
  const tones = [...new Set([...voices.keys()].map((k) => k.split('@')[0] as string))];
  for (const keyword of toneKeywords) {
    const words = keyword
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean);
    const phrase = words.join(' ');
    const tone = tones.find((t) => t === phrase || words.includes(t));
    if (!tone) continue;
    const voice = voices.get(`${tone}@${base}`) ?? voices.get(tone);
    if (voice) return voice;
  }
  return null;
}
