import { describe, expect, it } from 'vitest';
import { filterParams, likePatterns, MAX_SEARCH_OFFSET, parseCursor, queryTerms } from './search';

describe('library search helpers', () => {
  it('queryTerms lower-cases, dedupes and drops one-letter words and punctuation', () => {
    expect(queryTerms('Moody 5AM bakery POV — a POV!')).toEqual(['moody', '5am', 'bakery', 'pov']);
    expect(queryTerms('   ')).toEqual([]);
    expect(queryTerms('café crème brûlée')).toEqual(['café', 'crème', 'brûlée']);
    expect(queryTerms(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '))).toHaveLength(10);
  });

  it('likePatterns escapes LIKE wildcards', () => {
    expect(likePatterns(['50%', 'a_b', 'c\\d'])).toEqual(['%50\\%%', '%a\\_b%', '%c\\\\d%']);
  });

  it('parseCursor accepts offsets up to the cap', () => {
    expect(parseCursor(null)).toBe(0);
    expect(parseCursor(undefined)).toBe(0);
    expect(parseCursor('')).toBe(0);
    expect(parseCursor('24')).toBe(24);
    expect(() => parseCursor('-1')).toThrow('cursor');
    expect(() => parseCursor('abc')).toThrow('cursor');
    expect(() => parseCursor(String(MAX_SEARCH_OFFSET + 1))).toThrow('past the last page');
  });
});

describe('filterParams', () => {
  it('binds nothing when no filter is given', () => {
    expect(filterParams({})).toEqual({
      durationMin: null,
      durationMax: null,
      mood: null,
      tags: [],
    });
  });

  it('carries the length range, an escaped mood pattern and the tags', () => {
    expect(
      filterParams({ durationMin: 15, durationMax: 30, mood: ' up_beat% ', tags: ['bakery'] }),
    ).toEqual({ durationMin: 15, durationMax: 30, mood: '%up\\_beat\\%%', tags: ['bakery'] });
  });

  it('treats a blank mood as no mood filter', () => {
    expect(filterParams({ mood: '   ' }).mood).toBeNull();
  });
});
