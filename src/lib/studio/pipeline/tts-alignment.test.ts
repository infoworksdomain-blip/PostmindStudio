import { describe, expect, it } from 'vitest';
import { respellToScript } from '../overlays/script-spelling';
import {
  alignedWordsOf,
  alignmentToWords,
  parseCharacterAlignment,
  type CharacterAlignment,
} from './tts-alignment';

// 23.2 — ElevenLabs character alignment → caption word timings.

/** An alignment where character i spans [i*0.1, i*0.1 + 0.1). */
function aligned(text: string): CharacterAlignment {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => Math.round(i * 100) / 1000),
    character_end_times_seconds: characters.map((_, i) => Math.round((i + 1) * 100) / 1000),
  };
}

describe('alignmentToWords', () => {
  it('groups characters into words with the first start and last end', () => {
    expect(alignmentToWords(aligned('Fresh bread'), 'Fresh bread')).toEqual([
      { text: 'Fresh', startSec: 0, endSec: 0.5 },
      { text: 'bread', startSec: 0.6, endSec: 1.1 },
    ]);
  });

  it('keeps punctuation on its word and drops punctuation-only tokens', () => {
    const text = 'Still buying bread? Try ours - baked at dawn!';
    const words = alignmentToWords(aligned(text), text)!;
    expect(words.map((w) => w.text)).toEqual([
      'Still',
      'buying',
      'bread?',
      'Try',
      'ours',
      'baked',
      'at',
      'dawn!',
    ]);
  });

  it('treats runs of spaces, tabs and newlines as one break', () => {
    const text = 'Order   today.\n\nCollect\ttomorrow';
    expect(alignmentToWords(aligned(text), text)!.map((w) => w.text)).toEqual([
      'Order',
      'today.',
      'Collect',
      'tomorrow',
    ]);
  });

  it('keeps apostrophes inside words (straight and curly)', () => {
    const text = "Don't miss AheadAI’s offer, it's back";
    const words = alignmentToWords(aligned(text), text)!;
    expect(words.map((w) => w.text)).toEqual([
      "Don't",
      'miss',
      'AheadAI’s',
      'offer,',
      "it's",
      'back',
    ]);
  });

  it('splits scripts without spaces into one word per character', () => {
    const text = '新鲜面包';
    expect(alignmentToWords(aligned(text), text)!.map((w) => w.text)).toEqual([
      '新',
      '鲜',
      '面',
      '包',
    ]);
  });

  it('lines up one to one with the script spelling (respellToScript keeps it as is)', () => {
    const text = "That's where AheadAI steps in.";
    const words = alignmentToWords(aligned(text), text)!;
    expect(respellToScript(words, text)).toEqual(words);
  });

  it('rejects an alignment of different text (falls back to transcription)', () => {
    expect(alignmentToWords(aligned('Fresh bread'), 'Fresh bead')).toBeNull();
  });

  it('rejects an alignment whose times run backwards', () => {
    // The second word starting before the first is garbled.
    const backwards = aligned('one two');
    backwards.character_start_times_seconds[0] = 2;
    expect(alignmentToWords(backwards, 'one two')).toBeNull();
  });

  it('rejects text with no spoken word', () => {
    expect(alignmentToWords(aligned(' - '), ' - ')).toBeNull();
  });
});

describe('parseCharacterAlignment', () => {
  it('accepts the documented shape', () => {
    expect(parseCharacterAlignment(aligned('Hi'))).toEqual(aligned('Hi'));
  });

  it.each([
    null,
    'x',
    {},
    { characters: ['a'], character_start_times_seconds: [0], character_end_times_seconds: [] },
    { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] },
    {
      characters: ['a'],
      character_start_times_seconds: [Number.NaN],
      character_end_times_seconds: [1],
    },
    { characters: [1], character_start_times_seconds: [0], character_end_times_seconds: [1] },
  ])('rejects %j', (value) => {
    expect(parseCharacterAlignment(value)).toBeNull();
  });
});

describe('alignedWordsOf', () => {
  it('reads valid stored words', () => {
    const words = [{ text: 'Hi', startSec: 0, endSec: 0.2 }];
    expect(alignedWordsOf({ alignedWords: words })).toEqual(words);
  });

  it('is null when absent, empty or partly invalid', () => {
    expect(alignedWordsOf(null)).toBeNull();
    expect(alignedWordsOf({})).toBeNull();
    expect(alignedWordsOf({ alignedWords: [] })).toBeNull();
    expect(
      alignedWordsOf({ alignedWords: [{ text: 'Hi', startSec: 0, endSec: 0.2 }, { text: 1 }] }),
    ).toBeNull();
  });
});
