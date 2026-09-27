import { describe, expect, it } from 'vitest';
import { contentSafetyReviewCheck, evaluateContentSafety } from './quality-checks';
import { pendingSafetyReview } from './safety-review';
import { blocksGeneration, needsSafetyReview, type ScriptSafetyResult } from './script-safety';

// BACKLOG 13.17 — which results pause a run for review (the review lifecycle on a real database
// is covered by test/api/safety-reviews.test.ts and test/golden/admin-automation.test.ts).

const verdict = (v: ScriptSafetyResult['verdict']): ScriptSafetyResult => ({
  verdict: v,
  categories: [],
  reason: 'x',
});

describe('script safety', () => {
  it('REVIEW pauses for a person; BLOCK still stops for good; WARN/ALLOW proceed', () => {
    expect(needsSafetyReview(verdict('REVIEW'))).toBe(true);
    expect(needsSafetyReview(verdict('BLOCK'))).toBe(false);
    expect(blocksGeneration(verdict('BLOCK'))).toBe(true);
    expect(needsSafetyReview(verdict('WARN'))).toBe(false);
    expect(blocksGeneration(verdict('ALLOW'))).toBe(false);
  });
});

describe('content safety', () => {
  const scan = (maxScores: Record<string, number>) => ({
    scan: { framesAnalysed: 4, maxScores, flaggedFrames: [] },
  });

  it('a review-level class is the review check; a block-level class is not', () => {
    const review = evaluateContentSafety(scan({ knife_in_hand: 0.86 }));
    expect(contentSafetyReviewCheck([review])).toMatchObject({
      detail: 'Needs review: knife_in_hand=0.86',
    });
    expect(
      contentSafetyReviewCheck([evaluateContentSafety(scan({ yes_nazi: 0.9 }))]),
    ).toBeUndefined();
    expect(contentSafetyReviewCheck([evaluateContentSafety(scan({}))])).toBeUndefined();
    // A scan that could not run fails closed as a block, never as a review.
    expect(
      contentSafetyReviewCheck([evaluateContentSafety({ unavailable: 'no provider' })]),
    ).toBeUndefined();
  });
});

describe('pendingSafetyReview', () => {
  it('finds a PENDING marker only', () => {
    const marker = { id: 'sr-1', kind: 'content', state: 'PENDING', reason: 'x', at: 'now' };
    expect(pendingSafetyReview({ safetyReview: marker })).toEqual(marker);
    expect(pendingSafetyReview({ safetyReview: { ...marker, state: 'ALLOWED' } })).toBeUndefined();
    expect(pendingSafetyReview(null)).toBeUndefined();
    expect(pendingSafetyReview({})).toBeUndefined();
  });
});
