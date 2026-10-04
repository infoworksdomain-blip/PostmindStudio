import { normaliseWord, type SpokenWord } from './word-timing';

// Captions are built from the transcription of the narration (AssemblyAI), which can split or
// mishear names that the script spells exactly: production QA run 11 (2026-10-04) captioned
// "That's where a head AI steps in." for the script's "That's where AheadAI steps in.". The narration
// was generated FROM the script, so where the transcript and the script contain the same letters
// split differently ("a head AI" / "AheadAI", "Ahead AI" / "AheadAI", "AheadAI's" / "AheadAI 's"),
// the script's words are used with the transcript's timing.

/** How many transcript words may merge into one script word, and vice versa. */
const MAX_MERGE = 4;

/**
 * The transcript words re-spelt to the script. All-or-nothing: if any stretch of the transcript
 * does not line up letter-for-letter with the script (a misheard word, "2" read as "two", narration
 * trimmed mid-word), the transcript is returned unchanged, so this can never make captions worse.
 * Trailing script words with no transcript (narration trimmed) are allowed.
 */
export function respellToScript(
  words: SpokenWord[],
  scriptText: string | null | undefined,
): SpokenWord[] {
  const script = (scriptText ?? '').split(/\s+/).filter((t) => normaliseWord(t) !== '');
  if (words.length === 0 || script.length === 0) return words;
  const out: SpokenWord[] = [];
  let i = 0;
  let j = 0;
  while (i < words.length) {
    if (j >= script.length) return words;
    const step = matchStep(words, i, script, j);
    if (!step) return words;
    out.push(...step.words);
    i += step.used;
    j += step.consumed;
  }
  return out;
}

interface Step {
  words: SpokenWord[];
  /** Transcript words used. */
  used: number;
  /** Script words consumed. */
  consumed: number;
}

/** The smallest k transcript words and m script words (one of them 1) with the same letters. */
function matchStep(words: SpokenWord[], i: number, script: string[], j: number): Step | null {
  for (let size = 1; size <= MAX_MERGE; size += 1) {
    // k transcript words → one script word ("a head AI" → "AheadAI").
    const k = size;
    const spoken = words.slice(i, i + k);
    if (spoken.length === k && letters(spoken) === normaliseWord(script[j] as string)) {
      const first = spoken[0] as SpokenWord;
      const last = spoken[k - 1] as SpokenWord;
      return {
        words: [{ text: script[j] as string, startSec: first.startSec, endSec: last.endSec }],
        used: k,
        consumed: 1,
      };
    }
    // One transcript word → m script words ("AheadAI's" spoken as one token): split its time
    // in proportion to letters.
    const m = size;
    const written = script.slice(j, j + m);
    const word = words[i] as SpokenWord;
    if (
      m > 1 &&
      written.length === m &&
      normaliseWord(word.text) === written.map(normaliseWord).join('')
    ) {
      return { words: splitByLetters(word, written), used: 1, consumed: m };
    }
  }
  return null;
}

function letters(words: SpokenWord[]): string {
  return words.map((w) => normaliseWord(w.text)).join('');
}

function splitByLetters(word: SpokenWord, written: string[]): SpokenWord[] {
  const total = written.reduce((n, t) => n + normaliseWord(t).length, 0);
  const span = word.endSec - word.startSec;
  let at = word.startSec;
  return written.map((text, idx) => {
    const share = normaliseWord(text).length / total;
    const end =
      idx === written.length - 1 ? word.endSec : Math.round((at + span * share) * 1000) / 1000;
    const piece = { text, startSec: at, endSec: end };
    at = end;
    return piece;
  });
}
