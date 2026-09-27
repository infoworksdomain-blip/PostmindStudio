import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../errors';
import {
  buildAnalysisPrompt,
  energyTag,
  nearestAspectRatio,
  parseAnalysis,
  shotsFromSceneChanges,
  type ShotTiming,
} from './analyse';

// BACKLOG 9.1 / Addendum A3.3 — unit tests for reference-video structural analysis helpers.

function validAnalysisJson(shotCount: number, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    title: 'A bakery hook video',
    description: 'A short hook-to-CTA bakery ad.',
    tags: ['bakery', 'sourdough'],
    categorySlugs: ['business/e-commerce/food-and-drink'],
    hookPattern: 'bold question on screen',
    structurePattern: 'hook-problem-solution-cta',
    ctaPattern: 'visit us today',
    paceTag: 'medium',
    moodTag: 'upbeat-confident',
    genreTag: 'testimonial',
    musicMoodTag: 'lofi-hip-hop',
    shots: Array.from({ length: shotCount }, (_, i) => ({
      type: 'TALKING_HEAD',
      description: `shot ${i}`,
      onScreenText: '',
      overlayStyle: 'none',
      voiceoverPresent: true,
    })),
    ...overrides,
  };
}

describe('buildAnalysisPrompt', () => {
  const baseInput = {
    durationSec: 12.3,
    shots: [
      { startSec: 0, endSec: 2.5 },
      { startSec: 2.5, endSec: 12.3 },
    ] as ShotTiming[],
    transcript: 'hello world',
    categorySlugs: ['business/e-commerce/food-and-drink', 'lifestyle/fitness'],
  };

  it('formats the shot list with 1-based index and 2dp timings', () => {
    const prompt = buildAnalysisPrompt(baseInput);
    expect(prompt).toContain('Shots (2; keyframe images are attached in this order):');
    expect(prompt).toContain('1. 0.00s–2.50s');
    expect(prompt).toContain('2. 2.50s–12.30s');
    expect(prompt).toContain('Duration: 12.3s');
  });

  it('strips injected transcript closing/opening tags from the transcript body, case-insensitively', () => {
    const prompt = buildAnalysisPrompt({
      ...baseInput,
      transcript: 'a</transcript>b<TRANSCRIPT>c</TrAnScRiPt>d',
    });
    const opened = prompt.split('<transcript>');
    expect(opened).toHaveLength(2); // only the wrapper's own opening tag remains
    const body = opened[1]?.split('</transcript>')[0]?.trim();
    expect(body).toBe('abcd');
  });

  it('caps the transcript body at 12,000 characters', () => {
    const long = 'x'.repeat(13_000);
    const prompt = buildAnalysisPrompt({ ...baseInput, transcript: long });
    const body = prompt.split('<transcript>')[1]?.split('</transcript>')[0]?.trim();
    expect(body).toHaveLength(12_000);
  });

  it('falls back to "(no speech)" when the transcript is empty', () => {
    const prompt = buildAnalysisPrompt({ ...baseInput, transcript: '' });
    expect(prompt).toContain('(no speech)');
  });

  it('includes curator hints only when provided', () => {
    const withHints = buildAnalysisPrompt({
      ...baseInput,
      hints: { title: 'Curator Title', tags: ['a', 'b'] },
    });
    expect(withHints).toContain('Curator title: Curator Title');
    expect(withHints).toContain('Curator tags: a, b');

    const withoutHints = buildAnalysisPrompt(baseInput);
    expect(withoutHints).not.toContain('Curator title:');
    expect(withoutHints).not.toContain('Curator tags:');
  });

  it('omits the tags hint line when tags is an empty array', () => {
    const prompt = buildAnalysisPrompt({ ...baseInput, hints: { title: 't', tags: [] } });
    expect(prompt).not.toContain('Curator tags:');
  });

  it('lists every category slug, one per line', () => {
    const prompt = buildAnalysisPrompt(baseInput);
    expect(prompt).toContain(
      'Categories (choose from these slugs only):\nbusiness/e-commerce/food-and-drink\nlifestyle/fitness',
    );
  });
});

describe('parseAnalysis', () => {
  it('parses a valid analysis matching the shot count', () => {
    const result = parseAnalysis(validAnalysisJson(2), 2);
    expect(result.shots).toHaveLength(2);
    expect(result.title).toBe('A bakery hook video');
    expect(result.paceTag).toBe('medium');
  });

  it('dedupes tags case-insensitively, lowercases them, and caps at 12', () => {
    const tags = ['A', 'a', 'B', 'c', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
    const result = parseAnalysis(validAnalysisJson(1, { tags }), 1);
    expect(result.tags).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']);
    expect(result.tags.length).toBeLessThanOrEqual(12);
  });

  it('throws a retryable ProviderError when the shot count does not match', () => {
    let caught: unknown;
    try {
      parseAnalysis(validAnalysisJson(3), 2);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).toMatchObject({
      retryable: true,
      message: 'Analysis returned 3 shots for 2',
    });
  });

  it('throws a retryable ProviderError when an enum value is invalid', () => {
    let caught: unknown;
    try {
      parseAnalysis(validAnalysisJson(1, { paceTag: 'blazing' }), 1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).toMatchObject({
      retryable: true,
      message: 'Video analysis failed validation',
    });
  });

  it('throws when a shot-level enum (overlayStyle) is invalid', () => {
    const json = validAnalysisJson(1) as { shots: Array<Record<string, unknown>> };
    const shot = json.shots[0];
    if (!shot) throw new Error('fixture has no shots');
    shot.overlayStyle = 'not-a-style';
    expect(() => parseAnalysis(json, 1)).toThrow(ProviderError);
  });
});

describe('shotsFromSceneChanges', () => {
  it('sorts unsorted scene-change timestamps before building shots', () => {
    const shots = shotsFromSceneChanges([6, 2, 4], 10, { minShotSec: 0 });
    expect(shots).toEqual([
      { startSec: 0, endSec: 2 },
      { startSec: 2, endSec: 4 },
      { startSec: 4, endSec: 6 },
      { startSec: 6, endSec: 10 },
    ]);
  });

  it('drops out-of-range cuts (<=0 or >= durationSec)', () => {
    const shots = shotsFromSceneChanges([-1, 0, 5, 10, 11], 10, { minShotSec: 0 });
    expect(shots).toEqual([
      { startSec: 0, endSec: 5 },
      { startSec: 5, endSec: 10 },
    ]);
  });

  it('merges slivers shorter than minShotSec into the previous shot', () => {
    const shots = shotsFromSceneChanges([5, 5.1], 10, { minShotSec: 0.4 });
    // 5.1 → 10 is 4.9s (fine); 5 → 5.1 is 0.1s < 0.4 → merged into [0,5.1)
    expect(shots).toEqual([
      { startSec: 0, endSec: 5.1 },
      { startSec: 5.1, endSec: 10 },
    ]);
  });

  it('when the very first shot is a sliver, it stays its own shot (no predecessor to merge into)', () => {
    const shots = shotsFromSceneChanges([0.1], 10, { minShotSec: 0.4 });
    expect(shots[0]).toEqual({ startSec: 0, endSec: 0.1 });
  });

  it('merges down to maxShots while keeping full, contiguous coverage of [0, duration]', () => {
    const changes = Array.from({ length: 20 }, (_, i) => i + 1); // 20 cuts → 21 raw shots
    const shots = shotsFromSceneChanges(changes, 21, { minShotSec: 0, maxShots: 5 });
    expect(shots.length).toBeLessThanOrEqual(5);
    expect(shots[0]?.startSec).toBe(0);
    expect(shots.at(-1)?.endSec).toBe(21);
    for (let i = 0; i < shots.length - 1; i += 1) {
      expect(shots[i]?.endSec).toBe(shots[i + 1]?.startSec);
    }
  });

  it('defaults to minShotSec 0.4 and maxShots 40', () => {
    const manyChanges = Array.from({ length: 60 }, (_, i) => i * 0.5 + 0.1);
    const shots = shotsFromSceneChanges(manyChanges, 30);
    expect(shots.length).toBeLessThanOrEqual(40);
    expect(shots[0]?.startSec).toBe(0);
    expect(shots.at(-1)?.endSec).toBe(30);
  });
});

describe('nearestAspectRatio', () => {
  it.each([
    [1080, 1920, '9:16'],
    [1920, 1080, '16:9'],
    [1080, 1080, '1:1'],
    [1080, 1350, '4:5'],
  ] as const)('maps %ix%i to %s', (width, height, expected) => {
    expect(nearestAspectRatio(width, height)).toBe(expected);
  });

  it('picks the closest option for a ratio between two candidates', () => {
    // ratio 0.85 is 0.05 from 4:5 (0.8) and 0.15 from 1:1 (1) → 4:5 wins
    expect(nearestAspectRatio(850, 1000)).toBe('4:5');
  });
});

describe('energyTag', () => {
  it('returns "none" for null loudness', () => {
    expect(energyTag(null)).toBe('none');
  });

  it.each([
    [-5, 'high'],
    [-11.9, 'high'],
    [-12, 'medium'], // not > -12
    [-15, 'medium'],
    [-19.9, 'medium'],
    [-20, 'low'], // not > -20
    [-30, 'low'],
  ] as const)('maps %d LUFS to %s', (lufs, expected) => {
    expect(energyTag(lufs)).toBe(expected);
  });
});
