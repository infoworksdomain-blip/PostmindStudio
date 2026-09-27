import { describe, expect, it } from 'vitest';
import { alignKaraoke, normaliseWord, parseSpokenWords } from './word-timing';

const spoken = [
  { text: 'Fresh', startSec: 0.2, endSec: 0.5 },
  { text: 'bread,', startSec: 0.6, endSec: 0.9 },
  { text: 'every', startSec: 1.4, endSec: 1.7 },
  { text: 'Friday.', startSec: 1.8, endSec: 2.3 },
];

describe('normaliseWord', () => {
  it('drops punctuation and case', () => {
    expect(normaliseWord('Bread,')).toBe('bread');
    expect(normaliseWord('“Friday!”')).toBe('friday');
    expect(normaliseWord('20%')).toBe('20');
  });
});

describe('parseSpokenWords', () => {
  it('keeps only well-formed words', () => {
    expect(
      parseSpokenWords([
        { text: 'a', startSec: 0, endSec: 1 },
        { text: 'b', startSec: 'x', endSec: 1 },
        null,
        { text: 'c', startSec: Number.NaN, endSec: 1 },
      ]),
    ).toEqual([{ text: 'a', startSec: 0, endSec: 1 }]);
    expect(parseSpokenWords('nope')).toEqual([]);
  });
});

describe('alignKaraoke', () => {
  it('lights each word when it is spoken, relative to the overlay start', () => {
    expect(alignKaraoke('Fresh bread every Friday', spoken, 0, 3)).toEqual([0.2, 0.6, 1.4, 1.8]);
    expect(alignKaraoke('every Friday', spoken, 1, 3)).toEqual([0.4, 0.8]);
  });

  it('interpolates words the transcript missed', () => {
    const times = alignKaraoke('Fresh warm bread every Friday', spoken, 0, 3);
    expect(times).toHaveLength(5);
    expect(times?.[1]).toBeGreaterThan(0.2);
    expect(times?.[1]).toBeLessThan(0.6);
    expect(times).toEqual([...(times ?? [])].sort((a, b) => a - b));
  });

  it('returns null when the overlay does not match the narration', () => {
    expect(alignKaraoke('Totally different words here', spoken, 0, 3)).toBeNull();
    expect(alignKaraoke('', spoken, 0, 3)).toBeNull();
    expect(alignKaraoke('Fresh bread', [], 0, 3)).toBeNull();
    expect(alignKaraoke('Fresh bread', spoken, 2, 2)).toBeNull();
  });

  it('never returns a time outside the overlay', () => {
    const times = alignKaraoke('Fresh bread every Friday', spoken, 0, 1) ?? [];
    for (const t of times) expect(t).toBeLessThan(1);
  });
});
