import { describe, expect, it } from 'vitest';
import {
  allowedModes,
  embeddingDocument,
  ingestItemInput,
  mergeToFrames,
  previewKey,
} from './ingest';
import type { ShotTiming, VideoAnalysis } from './analyse';

// BACKLOG 9.1 / Addendum A3.3 — pure helper unit tests only (no S3/db/provider deps).

describe('previewKey', () => {
  it('appends -preview before the .mp4 extension', () => {
    expect(previewKey('library/abc123.mp4')).toBe('library/abc123-preview.mp4');
  });

  it('leaves a non-.mp4 key unchanged', () => {
    expect(previewKey('library/abc123.mov')).toBe('library/abc123.mov');
  });
});

describe('allowedModes', () => {
  it('disables TEMPLATE mode for SCRAPED sources (A3.1)', () => {
    expect(allowedModes('SCRAPED')).toEqual(['INSPIRE']);
  });

  it.each(['LICENSED', 'OWNED'] as const)('allows both modes for %s sources', (scenario) => {
    expect(allowedModes(scenario)).toEqual(['TEMPLATE', 'INSPIRE']);
  });
});

function analysis(overrides: Partial<VideoAnalysis> = {}): VideoAnalysis {
  return {
    title: 'A bakery hook video',
    description: 'A short hook-to-CTA bakery ad.',
    tags: ['bakery'],
    categorySlugs: ['business/e-commerce/food-and-drink'],
    hookPattern: 'bold question on screen',
    structurePattern: 'hook-problem-solution-cta',
    ctaPattern: 'visit us today',
    paceTag: 'medium',
    moodTag: 'upbeat-confident',
    genreTag: 'testimonial',
    musicMoodTag: 'lofi-hip-hop',
    shots: [
      {
        type: 'TALKING_HEAD',
        description: 'presenter talks',
        onScreenText: '',
        overlayStyle: 'none',
        voiceoverPresent: true,
      },
    ],
    ...overrides,
  };
}

describe('embeddingDocument', () => {
  it('includes title, description, tags, structure fields and a transcript excerpt', () => {
    const doc = embeddingDocument({
      title: 'My Video',
      description: 'A description',
      tags: ['a', 'b'],
      analysis: analysis(),
      transcript: 'hello there',
    });
    expect(doc).toContain('My Video');
    expect(doc).toContain('A description');
    expect(doc).toContain('Tags: a, b');
    expect(doc).toContain(
      'Hook: bold question on screen. Structure: hook-problem-solution-cta. CTA: visit us today.',
    );
    expect(doc).toContain(
      'Pace: medium. Mood: upbeat-confident. Genre: testimonial. Music: lofi-hip-hop.',
    );
    expect(doc).toContain('Shots: TALKING_HEAD (presenter talks)');
    expect(doc).toContain('Transcript: hello there');
  });

  it('shows "none" for an empty CTA pattern and omits the transcript line when there is no speech', () => {
    const doc = embeddingDocument({
      title: 't',
      description: 'd',
      tags: [],
      analysis: analysis({ ctaPattern: '' }),
      transcript: '',
    });
    expect(doc).toContain('CTA: none.');
    expect(doc).not.toContain('Transcript:');
  });

  it('caps the overall document at 8,000 characters', () => {
    const doc = embeddingDocument({
      title: 't',
      description: 'd'.repeat(9_000),
      tags: [],
      analysis: analysis(),
      transcript: '',
    });
    expect(doc.length).toBeLessThanOrEqual(8_000);
  });

  it('truncates the transcript excerpt within the document to 2,000 characters before the overall cap', () => {
    const doc = embeddingDocument({
      title: 't',
      description: 'd',
      tags: [],
      analysis: analysis(),
      transcript: 'y'.repeat(5_000),
    });
    const transcriptLine = doc.split('\n').find((l) => l.startsWith('Transcript:'));
    expect(transcriptLine).toBe(`Transcript: ${'y'.repeat(2_000)}`);
  });
});

describe('mergeToFrames', () => {
  const shots: ShotTiming[] = [
    { startSec: 0, endSec: 1 },
    { startSec: 1, endSec: 2 },
    { startSec: 2, endSec: 3 },
    { startSec: 3, endSec: 4 },
  ];

  it('groups neighbouring shots into frameCount buckets, spanning first-to-last', () => {
    const merged = mergeToFrames(shots, 2);
    expect(merged).toEqual([
      { startSec: 0, endSec: 2 },
      { startSec: 2, endSec: 4 },
    ]);
  });

  it('returns one shot per frame when frameCount equals the shot count', () => {
    expect(mergeToFrames(shots, 4)).toEqual(shots);
  });

  it('returns only the first shot when frameCount is 0 or negative', () => {
    expect(mergeToFrames(shots, 0)).toEqual([shots[0]]);
    expect(mergeToFrames(shots, -3)).toEqual([shots[0]]);
  });
});

describe('ingestItemInput', () => {
  const valid = {
    sourceUrl: 'https://example.com/video.mp4',
    licenseScenario: 'LICENSED' as const,
  };

  it('accepts a minimal valid input, defaulting tags to an empty array', () => {
    const parsed = ingestItemInput.parse(valid);
    expect(parsed.tags).toEqual([]);
    expect(parsed.sourceUrl).toBe(valid.sourceUrl);
  });

  it('rejects a non-URL sourceUrl', () => {
    expect(() => ingestItemInput.parse({ ...valid, sourceUrl: 'not-a-url' })).toThrow();
  });

  it('rejects an invalid licenseScenario', () => {
    expect(() => ingestItemInput.parse({ ...valid, licenseScenario: 'FREE' })).toThrow();
  });

  it('rejects a licenseExpires that is not ISO datetime', () => {
    expect(() => ingestItemInput.parse({ ...valid, licenseExpires: 'not-a-date' })).toThrow();
  });

  it('caps tags at 20 items and rejects an over-long tag', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    expect(() => ingestItemInput.parse({ ...valid, tags: tooMany })).toThrow();
    expect(() => ingestItemInput.parse({ ...valid, tags: ['x'.repeat(61)] })).toThrow();
  });

  it('accepts optional category, title and sourcePlatform', () => {
    const parsed = ingestItemInput.parse({
      ...valid,
      category: 'business/e-commerce',
      title: 'Custom title',
      sourcePlatform: 'tiktok',
    });
    expect(parsed).toMatchObject({
      category: 'business/e-commerce',
      title: 'Custom title',
      sourcePlatform: 'tiktok',
    });
  });
});
