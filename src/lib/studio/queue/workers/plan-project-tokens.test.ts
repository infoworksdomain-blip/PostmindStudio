import { describe, expect, it } from 'vitest';
import { ideationMaxTokens, MAX_PLANNING_OUTPUT_TOKENS } from './plan-project';

// Production 2026-10-03: a nine-platform brief hit "output_truncated: Output hit max_tokens
// (4000)" because ideation drafts a caption and hashtags per platform (20.13).
describe('ideationMaxTokens', () => {
  it('leaves room for one platform as before', () => {
    expect(ideationMaxTokens(1)).toBeGreaterThanOrEqual(3_900);
  });

  it('grows with each target platform so nine platforms fit', () => {
    expect(ideationMaxTokens(9)).toBeGreaterThan(ideationMaxTokens(1));
    expect(ideationMaxTokens(9)).toBeGreaterThanOrEqual(11_000);
  });

  it('never exceeds the fallback provider output limit', () => {
    expect(ideationMaxTokens(40)).toBe(MAX_PLANNING_OUTPUT_TOKENS);
    expect(ideationMaxTokens(0)).toBe(ideationMaxTokens(1));
  });
});
