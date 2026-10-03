import { describe, expect, it } from 'vitest';
import { isRelevant, MIN_SIMILARITY } from './relevance';

describe('library search relevance floor', () => {
  it('lists an item at or above the floor', () => {
    expect(isRelevant(MIN_SIMILARITY, 0)).toBe(true);
    expect(isRelevant(0.6, 0)).toBe(true);
  });

  it('drops a weak match with no query word in its title or tags', () => {
    expect(isRelevant(0.12, 0)).toBe(false);
    expect(isRelevant(MIN_SIMILARITY - 0.01, 0)).toBe(false);
  });

  it('keeps a weak embedding match when a query word is in the title or tags', () => {
    expect(isRelevant(0.12, 0.05)).toBe(true);
  });
});
