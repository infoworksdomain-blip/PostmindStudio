import { normaliseWord, parseSpokenWords, type SpokenWord } from '../overlays/word-timing';

// BACKLOG 23.2 — narration word timings from the TTS itself. ElevenLabs "Create speech with
// timing" (POST /v1/text-to-speech/{voice_id}/with-timestamps,
// https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps, read 2026-10-06)
// returns the audio (audio_base64) and `alignment` (CharacterAlignmentResponseModel, "timestamp
// information for each character in the original text"): characters[],
// character_start_times_seconds[], character_end_times_seconds[]. Only those documented fields
// are read. The characters are grouped into the words the captions expect (SpokenWord: text, start
// and end in seconds from the start of the narration), split exactly like the script text is
// (whitespace; punctuation stays on its word, a token with no letter or digit is dropped), so
// respellToScript lines them up one to one.
//
// Studio sent AssemblyAI its own narration to get these timings (production 2026-10-06: 17–43 s of
// transcription per AI video). An alignment that is missing or does not describe the text that was
// spoken is rejected (null) and the narration is transcribed as before (pipeline/word-timing.ts).

export interface CharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** Scripts without spaces between words: each character is its own caption word. */
const CHARACTER_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** The documented alignment object from an untrusted response, or null. */
export function parseCharacterAlignment(value: unknown): CharacterAlignment | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const chars = v.characters;
  const starts = v.character_start_times_seconds;
  const ends = v.character_end_times_seconds;
  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends)) return null;
  if (chars.length === 0 || chars.length !== starts.length || chars.length !== ends.length)
    return null;
  if (!chars.every((c) => typeof c === 'string')) return null;
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!starts.every(finite) || !ends.every(finite)) return null;
  return {
    characters: chars as string[],
    character_start_times_seconds: starts as number[],
    character_end_times_seconds: ends as number[],
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Caption words from a character alignment, or null when the alignment does not describe `text`
 * (its characters, ignoring whitespace, must spell the text) or yields no word.
 */
export function alignmentToWords(alignment: CharacterAlignment, text: string): SpokenWord[] | null {
  const spelled = alignment.characters.join('').replace(/\s+/g, '');
  if (spelled !== text.replace(/\s+/g, '')) return null;
  const words: SpokenWord[] = [];
  let current: { text: string; startSec: number; endSec: number } | null = null;
  const flush = () => {
    if (current && normaliseWord(current.text) !== '') {
      words.push({
        text: current.text,
        startSec: round(current.startSec),
        endSec: round(Math.max(current.startSec, current.endSec)),
      });
    }
    current = null;
  };
  alignment.characters.forEach((char, i) => {
    const start = alignment.character_start_times_seconds[i] as number;
    const end = alignment.character_end_times_seconds[i] as number;
    if (/^\s+$/.test(char)) return flush();
    if (CHARACTER_SCRIPT.test(char)) {
      flush();
      current = { text: char, startSec: start, endSec: end };
      return flush();
    }
    if (current) current = { ...current, text: current.text + char, endSec: end };
    else current = { text: char, startSec: start, endSec: end };
  });
  flush();
  if (words.length === 0) return null;
  // Times must run forward: a garbled alignment is not used.
  for (let i = 1; i < words.length; i += 1) {
    if ((words[i] as SpokenWord).startSec + 0.001 < (words[i - 1] as SpokenWord).startSec)
      return null;
  }
  return words;
}

/** metadata.alignedWords on a narration asset (set by the ElevenLabs adapter), or null. */
export function alignedWordsOf(metadata: unknown): SpokenWord[] | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).alignedWords;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const words = parseSpokenWords(raw);
  return words.length === raw.length ? words : null;
}
