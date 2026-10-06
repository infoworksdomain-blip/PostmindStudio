import { describe, expect, it } from 'vitest';
import { fingerprintOf, isNearDuplicate, jaccard, tokens } from './fingerprint';

describe('no_unique_content fingerprints', () => {
  it('keeps meaningful words only, folded and sorted', () => {
    expect(tokens('Why your Sourdough is FLAT — and how to fix it!')).toEqual([
      'sourdough',
      'flat',
      'fix',
    ]);
    expect(fingerprintOf('Crème brûlée', 'Crème tips')).toBe('brulee creme tips');
  });

  it('flags a reworded repeat but not a different topic', () => {
    const a = fingerprintOf('3 reasons your sourdough is flat', 'Flat sourdough? Three reasons');
    const b = fingerprintOf(
      'Why is my sourdough flat: 3 reasons',
      'Three reasons sourdough goes flat',
    );
    const c = fingerprintOf('Our new rye loaf is here', 'Meet the rye');
    expect(jaccard(a, b)).toBeGreaterThanOrEqual(0.6);
    expect(isNearDuplicate(b, [a])).toBe(true);
    expect(isNearDuplicate(c, [a, b])).toBe(false);
    expect(isNearDuplicate('', [a])).toBe(false);
  });
});
