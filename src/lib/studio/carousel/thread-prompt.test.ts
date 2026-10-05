import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../errors';
import {
  buildPostRewritePrompt,
  buildThreadPrompt,
  HOOK_FRAMEWORKS,
  parsePostRewrite,
  parseThreadResult,
  THREAD_OUTPUT_SCHEMA,
  THREAD_SYSTEM_PROMPT,
} from './thread-prompt';

const context = {
  language: 'fr',
  facts: { businessName: 'Boulangerie """Lune"""', industry: 'bakery', products: ['croissants'] },
  voice: ['warm', 'witty'],
  audienceProfile: 'local families',
  restrictedTopics: ['alcohol'],
};

describe('thread system prompt', () => {
  it('offers the five allowed hook frameworks and not "borrowed authority"', () => {
    expect(HOOK_FRAMEWORKS).toEqual([
      'surprising_statistic',
      'direct_listicle',
      'everyone',
      'numbers_up_front',
      'direct_you',
    ]);
    expect(THREAD_SYSTEM_PROMPT.toLowerCase()).not.toContain('borrowed authority');
    expect(THREAD_OUTPUT_SCHEMA.properties.hookFramework.enum).toEqual([...HOOK_FRAMEWORKS]);
  });

  it('forbids naming real people and inventing claims', () => {
    expect(THREAD_SYSTEM_PROMPT).toContain('Never name real people anywhere in the thread.');
    expect(THREAD_SYSTEM_PROMPT).toContain('Never invent prices');
    expect(THREAD_SYSTEM_PROMPT).toContain('Never mention a restricted topic.');
  });

  it('teaches the skill’s structure: hook, one idea per post, bullets, waterfall, CTA', () => {
    expect(THREAD_SYSTEM_PROMPT).toContain('Post 1 is the hook');
    expect(THREAD_SYSTEM_PROMPT).toContain('one idea per post');
    expect(THREAD_SYSTEM_PROMPT).toContain('"→ "');
    expect(THREAD_SYSTEM_PROMPT).toContain('shortest to the longest');
    expect(THREAD_SYSTEM_PROMPT).toContain('7 is the sweet spot');
    expect(THREAD_SYSTEM_PROMPT).toContain('follow, save, share or comment');
  });
});

describe('buildThreadPrompt', () => {
  it('asks for the post count, in the project language, with voice, facts and restricted topics', () => {
    const prompt = buildThreadPrompt({
      ...context,
      brief: 'Our new """sourdough"""',
      postCount: 7,
    });
    expect(prompt).toContain('exactly 7 posts');
    expect(prompt).toContain('Restricted topics (never mention): alcohol');
    expect(prompt).toContain('Brand voice: warm, witty');
    expect(prompt).toContain('Business: Boulangerie "Lune"');
    expect(prompt).toContain('Our new "sourdough"');
    // The language instruction (languages.ts) names French.
    expect(prompt).toMatch(/French|français/);
  });

  it('notes a chosen direction and confirmed topics', () => {
    const prompt = buildThreadPrompt({
      ...context,
      brief: 'b',
      postCount: 5,
      directionChosen: true,
      restrictedTopicsConfirmed: true,
    });
    expect(prompt).toContain('treat the brief as actionable');
    expect(prompt).toContain('confirmed the restricted topics');
  });
});

describe('buildPostRewritePrompt', () => {
  it('names the role of the post and fences the thread and request as data', () => {
    const prompt = buildPostRewritePrompt({
      ...context,
      brief: 'b',
      posts: ['Hook', 'Middle', 'Follow us'],
      index: 2,
      instruction: 'shorter',
    });
    expect(prompt).toContain('post 3 of this 3-post thread; it is the call to action');
    expect(prompt).toContain('[2] Middle');
    expect(prompt).toContain('shorter');
  });
});

describe('parseThreadResult', () => {
  const answer = {
    actionable: true,
    directionOptions: [],
    restrictedTopicsMentioned: [],
    hookFramework: 'direct_listicle',
    posts: [
      { text: '7 ways to keep bread fresh:', imageQuery: 'sourdough loaf on a board' },
      { text: 'x'.repeat(700), imageQuery: '' },
      { text: 'Follow for more', imageQuery: '' },
      { text: 'extra', imageQuery: '' },
    ],
  };

  it('keeps the requested number of posts and caps their length', () => {
    const result = parseThreadResult(answer, 3);
    expect(result.posts).toHaveLength(3);
    expect(result.posts[1]?.text).toHaveLength(600);
  });

  it('rejects malformed output as a retryable provider error', () => {
    expect(() => parseThreadResult({ posts: 'nope' }, 3)).toThrow(ProviderError);
    expect(() => parseThreadResult({ ...answer, posts: [answer.posts[0]] }, 7)).toThrow(
      'Thread has too few posts',
    );
  });

  it('accepts a not-actionable answer with directions and no posts', () => {
    const result = parseThreadResult(
      { ...answer, actionable: false, directionOptions: ['A', 'B'], posts: [] },
      7,
    );
    expect(result.actionable).toBe(false);
  });

  it('parses a single rewritten post', () => {
    expect(parsePostRewrite({ text: ' New hook ' })).toBe('New hook');
    expect(() => parsePostRewrite({})).toThrow(ProviderError);
  });
});
