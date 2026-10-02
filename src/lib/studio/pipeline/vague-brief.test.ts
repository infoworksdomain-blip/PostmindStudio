import { describe, expect, it } from 'vitest';
import type { IdeationResult } from './ideation';
import {
  directionOptionsOf,
  forceActionable,
  isVagueBriefReason,
  MAX_DIRECTION_CHARS,
  VAGUE_BRIEF_REASON,
} from './vague-brief';

const vague: IdeationResult = {
  actionable: false,
  directionOptions: ['Launch countdown', 'Space facts', 'Studio tour'],
  hook: '',
  keyMessage: '',
  targetAudience: '',
  tone: '',
  callToAction: '',
  keywords: [],
  restrictedTopicsMentioned: [],
};

describe('isVagueBriefReason', () => {
  it('matches the stored reason and the customer-facing code', () => {
    expect(isVagueBriefReason(VAGUE_BRIEF_REASON)).toBe(true);
    expect(isVagueBriefReason('brief_too_vague')).toBe(true);
    expect(isVagueBriefReason('  brief_too_vague: anything ')).toBe(true);
  });

  it('does not match other reasons', () => {
    expect(isVagueBriefReason(null)).toBe(false);
    expect(isVagueBriefReason(undefined)).toBe(false);
    expect(isVagueBriefReason('restricted_topics: user confirmation required')).toBe(false);
    expect(isVagueBriefReason('brief_too_vaguely')).toBe(false);
  });
});

describe('directionOptionsOf', () => {
  it('keeps at most three trimmed, non-empty strings', () => {
    expect(directionOptionsOf([' A ', '', 'B\n\nC', 4, null, 'D', 'E'])).toEqual(['A', 'B C', 'D']);
  });

  it('caps a very long direction', () => {
    expect(directionOptionsOf(['x'.repeat(2_000)])[0]).toHaveLength(MAX_DIRECTION_CHARS);
  });

  it('returns [] for anything that is not a list', () => {
    expect(directionOptionsOf(undefined)).toEqual([]);
    expect(directionOptionsOf('A')).toEqual([]);
    expect(directionOptionsOf({ 0: 'A' })).toEqual([]);
  });
});

describe('forceActionable', () => {
  it('leaves an actionable brief alone', () => {
    const ok = { ...vague, actionable: true, hook: 'h', keyMessage: 'k' };
    expect(forceActionable(ok, { briefText: 'space video' })).toBe(ok);
  });

  it('turns a second "too vague" answer into a brief from the first direction', () => {
    const forced = forceActionable(vague, {
      briefText: 'space video',
      audience: 'Founders',
      toneKeywords: ['bold', 'playful'],
    });
    expect(forced).toMatchObject({
      actionable: true,
      directionOptions: [],
      hook: 'Launch countdown',
      keyMessage: 'Launch countdown',
      targetAudience: 'Founders',
      tone: 'bold, playful',
    });
  });

  it("keeps the model's own fields where it wrote them", () => {
    const forced = forceActionable(
      { ...vague, hook: 'Ready for lift-off?', tone: 'excited' },
      { briefText: 'space video' },
    );
    expect(forced.hook).toBe('Ready for lift-off?');
    expect(forced.tone).toBe('excited');
    expect(forced.keyMessage).toBe('Launch countdown');
  });

  it("falls back to the owner's text and neutral defaults when there is nothing else", () => {
    const forced = forceActionable(
      { ...vague, directionOptions: [] },
      { briefText: '  space\n video ', audience: '  ' },
    );
    expect(forced).toMatchObject({
      actionable: true,
      hook: 'space video',
      keyMessage: 'space video',
      targetAudience: "the business's customers",
      tone: 'warm, clear, confident',
    });
  });

  it('keeps the hook short', () => {
    const forced = forceActionable(
      { ...vague, directionOptions: ['y'.repeat(400)] },
      { briefText: 'x' },
    );
    expect(forced.hook).toHaveLength(200);
    expect(forced.keyMessage).toHaveLength(400);
  });
});
