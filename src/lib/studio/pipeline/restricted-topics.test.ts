import { describe, expect, it } from 'vitest';
import {
  isRestrictedTopicsReason,
  MAX_PENDING_TOPICS,
  MAX_TOPIC_CHARS,
  pendingTopicsOf,
  RESTRICTED_TOPICS_REASON,
} from './restricted-topics';

describe('isRestrictedTopicsReason', () => {
  it('matches the stored reason and the customer-facing code', () => {
    expect(isRestrictedTopicsReason(RESTRICTED_TOPICS_REASON)).toBe(true);
    expect(isRestrictedTopicsReason('restricted_topics')).toBe(true);
    expect(isRestrictedTopicsReason(' restricted_topics: anything')).toBe(true);
  });

  it('does not match other reasons', () => {
    expect(isRestrictedTopicsReason(null)).toBe(false);
    expect(isRestrictedTopicsReason(undefined)).toBe(false);
    expect(isRestrictedTopicsReason('brief_too_vague')).toBe(false);
    expect(isRestrictedTopicsReason('restricted_topicsx')).toBe(false);
  });
});

describe('pendingTopicsOf', () => {
  it('keeps unique, trimmed, non-empty strings', () => {
    expect(pendingTopicsOf([' politics ', '', 'politics', 'alcohol\n\nbrands', 3, null])).toEqual([
      'politics',
      'alcohol brands',
    ]);
  });

  it('caps the count and the length', () => {
    const many = Array.from({ length: 20 }, (_, i) => `topic ${i}`);
    expect(pendingTopicsOf(many)).toHaveLength(MAX_PENDING_TOPICS);
    expect(pendingTopicsOf(['x'.repeat(500)])[0]).toHaveLength(MAX_TOPIC_CHARS);
  });

  it('returns [] for anything that is not a list', () => {
    expect(pendingTopicsOf(undefined)).toEqual([]);
    expect(pendingTopicsOf('politics')).toEqual([]);
  });
});
