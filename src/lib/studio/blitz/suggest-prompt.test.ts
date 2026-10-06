import { describe, expect, it } from 'vitest';
import {
  blitzSystemPrompt,
  buildSuggestPrompt,
  hookTypeAt,
  HOOK_TYPES,
  parseSuggestResult,
} from './suggest-prompt';

const card = (index: number) => ({
  index,
  title: `Card ${index}`,
  hook: 'Bakers who rush the prove: stop.',
  body: ['Give it time', 'Watch the dome', 'Poke test'],
  cta: 'Order a loaf',
  imageQueries: ['dough rising', 'domed loaf', 'finger poke'],
  caption: 'Bakers who rush the prove: stop.',
  hashtags: ['sourdough'],
  whyItWorks: 'A call-out hook names the audience in the first second.',
});

describe('Blitz suggestion prompt', () => {
  it('names each card’s format, angle, hook type, mention rule and remix', () => {
    const prompt = buildSuggestPrompt({
      facts: { businessName: 'Leeds Sourdough', restrictedTopics: ['politics'] },
      recentPosts: ['Our new rye'],
      cards: [
        {
          index: 1,
          format: 'carousel',
          angle: {
            title: 'Baking tips',
            description: 'Home baking help',
            targetAudience: 'home bakers',
          },
          hookType: 'call_out',
          mentionBusiness: false,
          remix: { title: 'Reference', notes: 'question hook; listicle; fast pace' },
        },
        { index: 2, format: 'ugc', angle: null, hookType: 'mistake', mentionBusiness: true },
      ],
    });
    expect(prompt).toContain('Leeds Sourdough');
    expect(prompt).toContain('Restricted topics (never mention): politics');
    expect(prompt).toContain(
      '1. carousel — angle "Baking tips" (Home baking help) for home bakers — hook framework: call_out — do not name the business',
    );
    expect(prompt).toContain('remix the structure of the reference');
    expect(prompt).toContain(
      '2. ugc — any angle that fits the business — hook framework: mistake — may name the business',
    );
    expect(prompt).not.toContain('Write exactly 0 posts');
  });

  it('system prompt forbids real people and invented claims', () => {
    const system = blitzSystemPrompt();
    expect(system).toMatch(/Never name or depict a real, identifiable person/);
    expect(system).toMatch(/Never invent prices/);
  });

  it('keeps good cards, nulls unusable ones, and rejects garbage', () => {
    const result = parseSuggestResult(
      { cards: [card(1), { ...card(2), body: ['only one'] }, { index: 3 }] },
      3,
    );
    expect(result[0]?.title).toBe('Card 1');
    expect(result[1]).toBeNull();
    expect(result[2]).toBeNull();
    expect(() => parseSuggestResult('nope', 1)).toThrow(/failed validation/);
  });

  it('rotates hook types', () => {
    expect(new Set(HOOK_TYPES.map((_, i) => hookTypeAt(i))).size).toBe(HOOK_TYPES.length);
    expect(hookTypeAt(-1)).toBe(HOOK_TYPES[HOOK_TYPES.length - 1]);
  });
});
