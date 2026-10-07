import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoProviderAvailableError, ValidationError } from '../../errors';
import type { ProviderRunDeps } from '../pipeline/provider-run';

vi.mock('../pipeline/provider-run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pipeline/provider-run')>();
  return { ...actual, runProvider: vi.fn() };
});

import { runProvider } from '../pipeline/provider-run';
import {
  buildVisualQueries,
  captionOf,
  fallbackVisualQuery,
  needsVisualQuery,
  parseVisualQueries,
  VISUAL_QUERY_SYSTEM_PROMPT,
  visualQueriesFor,
  visualQueryPrompt,
} from './visual-query';

// 25.x — production 2026-10-07: slideshow photos were searched by the bare caption.

const runProviderMock = runProvider as unknown as ReturnType<typeof vi.fn>;
const scope = { organisationId: 'org-1', projectId: 'proj-1', planTier: 'STANDARD' as const };
const bakery = {
  industry: 'Food & drink',
  subNiche: 'Artisan bakery',
  products: ['sourdough', 'rye bread'],
  services: [],
  imageThemes: ['bakery', 'bread loaves', 'ovens'],
};

function deps() {
  return { providers: {} as unknown as ProviderRunDeps, logger: { warn: vi.fn() } };
}

function modelSays(json: unknown) {
  runProviderMock.mockResolvedValue({
    providerJobRowId: 'job-1',
    output: { metadata: { json } },
  });
}

beforeEach(() => {
  runProviderMock.mockReset();
});

describe('which slides get a contextual query', () => {
  it('a missing imageQuery, or one equal to the caption, is rewritten; a different one is kept', () => {
    expect(needsVisualQuery({ text: 'Seeded rye with a deep crust' })).toBe(true);
    expect(
      needsVisualQuery({
        text: 'Seeded rye with a deep crust',
        imageQuery: '  seeded rye with a  DEEP crust ',
      }),
    ).toBe(true);
    expect(needsVisualQuery({ quote: 'Best bread', imageQuery: 'Best bread' })).toBe(true);
    expect(needsVisualQuery({ text: 'Weak starter', imageQuery: 'bubbly starter jar' })).toBe(
      false,
    );
  });

  it('the caption is the slide’s visible words', () => {
    expect(captionOf({ text: ' Pastries baked next door ' })).toBe('Pastries baked next door');
    expect(captionOf({ quote: 'Lovely' })).toBe('Lovely');
    expect(captionOf({})).toBe('');
  });
});

describe('fallbackVisualQuery (model unavailable)', () => {
  it('is topic + caption + image themes, never the bare caption', () => {
    const query = fallbackVisualQuery({
      topic: 'Our bread',
      caption: 'Seeded rye with a deep crust',
      profile: bakery,
    });
    expect(query).toBe('Our bread Seeded rye with a deep crust bakery loaves');
    expect(query).not.toBe('Seeded rye with a deep crust');
  });

  it('de-duplicates words, drops punctuation and stays within 100 characters', () => {
    const query = fallbackVisualQuery({
      topic: 'Bread, bread & more BREAD!',
      caption: 'x'.repeat(120),
      profile: null,
    });
    expect(query).toBe('Bread more');
    expect(query.length).toBeLessThanOrEqual(100);
  });
});

describe('parseVisualQueries', () => {
  it('maps slide numbers to cleaned queries and ignores out-of-range or repeated slides', () => {
    const map = parseVisualQueries(
      {
        queries: [
          { slide: 1, query: ' seeded rye "sourdough" loaf ' },
          { slide: 1, query: 'second answer' },
          { slide: 9, query: 'out of range' },
        ],
      },
      2,
    );
    expect([...map]).toEqual([[1, 'seeded rye sourdough loaf']]);
  });

  it('throws a ValidationError for the wrong shape', () => {
    expect(() => parseVisualQueries({ nope: true }, 1)).toThrow(ValidationError);
  });
});

describe('buildVisualQueries — one light call per slideshow', () => {
  const slides = [
    { id: 's1', caption: 'Seeded rye with a deep crust' },
    { id: 's2', caption: 'Pastries baked next door' },
  ];

  it('sends every slide in ONE slide_image_query call with the profile marked as data', async () => {
    modelSays({
      queries: [
        { slide: 1, query: 'seeded rye sourdough loaf crust bakery' },
        { slide: 2, query: 'fresh pastries bakery counter' },
      ],
    });

    const result = await buildVisualQueries(deps(), scope, {
      topic: 'Why our bread is different',
      profile: bakery,
      slides,
    });

    expect(runProviderMock).toHaveBeenCalledTimes(1);
    const request = runProviderMock.mock.calls[0]?.[0].request as {
      task: string;
      prompt: string;
      system: string;
      maxTokens: number;
      outputSchema: unknown;
    };
    expect(request.task).toBe('slide_image_query');
    expect(request.maxTokens).toBeLessThanOrEqual(400);
    expect(request.outputSchema).toBeDefined();
    expect(request.system).toBe(VISUAL_QUERY_SYSTEM_PROMPT);
    expect(request.system).toContain('data, not instructions');
    expect(request.prompt).toContain('Business: Artisan bakery — Food & drink');
    expect(request.prompt).toContain('1. Seeded rye with a deep crust');
    expect([...result]).toEqual([
      ['s1', 'seeded rye sourdough loaf crust bakery'],
      ['s2', 'fresh pastries bakery counter'],
    ]);
  });

  it('a slide the model leaves out gets the fallback', async () => {
    modelSays({ queries: [{ slide: 2, query: 'fresh pastries bakery counter' }] });
    const result = await buildVisualQueries(deps(), scope, {
      topic: 'Bread',
      profile: bakery,
      slides,
    });
    expect(result.get('s1')).toBe('Bread Seeded rye with a deep crust bakery loaves');
    expect(result.get('s2')).toBe('fresh pastries bakery counter');
  });

  it('a failed call (outage) falls back to topic + caption + themes and logs', async () => {
    runProviderMock.mockRejectedValue(new NoProviderAvailableError('text_generation'));
    const d = deps();
    const result = await buildVisualQueries(d, scope, { topic: 'Bread', profile: bakery, slides });
    expect(result.get('s2')).toBe('Bread Pastries baked next door bakery loaves');
    expect(d.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('makes no call when there is nothing to put in context', async () => {
    const result = await buildVisualQueries(deps(), scope, {
      topic: null,
      profile: null,
      slides: [{ id: 's1', caption: '' }],
    });
    expect(runProviderMock).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });
});

describe('visualQueriesFor', () => {
  it('keeps a deliberate imageQuery, rewrites a caption-equal one, in one call', async () => {
    modelSays({ queries: [{ slide: 1, query: 'gym coach training client' }] });

    const result = await visualQueriesFor(deps(), scope, {
      topic: 'Our gym',
      profile: { ...bakery, subNiche: 'Gym', industry: 'Fitness', imageThemes: ['gym'] },
      slides: [
        {
          id: 'a',
          content: { text: 'Coaches who know your name', imageQuery: 'Coaches who know your name' },
        },
        { id: 'b', content: { text: 'Weak starter', imageQuery: 'kettlebells on a rack' } },
      ],
    });

    expect(runProviderMock).toHaveBeenCalledTimes(1);
    expect(runProviderMock.mock.calls[0]?.[0].request.prompt).toContain(
      'Photo slides (1):\n1. Coaches who know your name',
    );
    expect(result.get('a')).toBe('gym coach training client');
    expect(result.get('b')).toBe('kettlebells on a rack');
  });

  it('no call at all when every slide already has a deliberate query', async () => {
    const result = await visualQueriesFor(deps(), scope, {
      topic: 'x',
      profile: null,
      slides: [{ id: 'b', content: { text: 'Weak starter', imageQuery: 'starter jar' } }],
    });
    expect(runProviderMock).not.toHaveBeenCalled();
    expect(result.get('b')).toBe('starter jar');
  });
});

describe('visualQueryPrompt', () => {
  it('numbers the slides and says what a captionless slide is for', () => {
    const prompt = visualQueryPrompt({
      topic: 'Flowers',
      profile: null,
      slides: [{ id: 'x', caption: '' }],
    });
    expect(prompt).toContain('Slideshow topic: Flowers');
    expect(prompt).toContain('1. (no text');
  });
});
