import { describe, expect, it } from 'vitest';
import { orderWaterfall, waterfallBullets } from './waterfall';

describe('orderWaterfall', () => {
  it('orders lines from the shortest to the longest, stable for ties', () => {
    expect(orderWaterfall(['ccc', 'a', 'bb', 'dd'])).toEqual(['a', 'bb', 'dd', 'ccc']);
  });
});

describe('waterfallBullets', () => {
  it('reorders each run of bullets and leaves other lines in place', () => {
    expect(waterfallBullets('Why:\n→ the longest reason\n- short\n→ mid one\n\nDone')).toBe(
      'Why:\n→ short\n→ mid one\n→ the longest reason\n\nDone',
    );
  });

  it('keeps text without bullets as it was (paragraphs kept)', () => {
    expect(waterfallBullets('One\n\nTwo')).toBe('One\n\nTwo');
  });
});
