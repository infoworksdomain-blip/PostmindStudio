import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { AssetStorage } from '../storage';
import { getLibraryVideo } from './library';

// A3.10: users never get the reference's content, only what the screen needs. The detail answer
// must not carry the transcript, the per-shot descriptions / on-screen text or the overlay
// timeline of the analysed video.

const row = {
  id: 'lib_1',
  title: 'Sourdough morning',
  description: 'A bakery opening',
  categoryId: 'cat_1',
  category: { slug: 'food', name: 'Food' },
  tags: ['bakery'],
  sourceUrl: 'https://example.test/original.mp4',
  sourcePlatform: 'tiktok',
  sourceRef: 'ref-1',
  s3Bucket: 'library',
  s3Key: 'a/b.mp4',
  thumbnailS3Key: 'a/b.jpg',
  durationSec: 21,
  aspectRatio: '9:16',
  ingestedAt: new Date('2026-09-01T00:00:00Z'),
  retiredAt: null,
  categoryReview: 'ACCEPTED',
  categoryReviewedAt: new Date('2026-09-02T00:00:00Z'),
  reanalysedAt: null,
  analysis: {
    id: 'an_1',
    libraryItemId: 'lib_1',
    shotCount: 2,
    shots: [{ startSec: 0, endSec: 9, type: 'TALKING_HEAD', onScreenText: 'Secret script words' }],
    transcript: { words: [{ text: 'secret', startSec: 0, endSec: 1 }] },
    overlayTimeline: [{ startSec: 0, endSec: 2, text: 'Overlay words' }],
    musicEnvelope: { bpm: 96 },
    hookPattern: 'question',
    structurePattern: 'hook-demo-cta',
    ctaPattern: 'visit',
    paceTag: 'medium',
    moodTag: 'warm',
    analysisVersion: 1,
  },
  license: {
    id: 'lic_1',
    libraryItemId: 'lib_1',
    scenario: 'OWNED',
    licenseSource: 'contract 7',
    licenseExpires: null,
    allowedModes: ['TEMPLATE', 'INSPIRE'],
    notes: 'internal note',
  },
};

const db = {
  videoLibraryItem: { findFirst: async () => row },
} as unknown as PrismaClient;
const storage = {
  signedUrl: async (bucket: string, key: string) => `https://signed.test/${bucket}/${key}`,
} as unknown as AssetStorage;

describe('getLibraryVideo', () => {
  it('returns the summary the screen needs and none of the reference content', async () => {
    const video = await getLibraryVideo({ db, storage }, 'lib_1');
    expect(video.analysis).toEqual({
      shotCount: 2,
      hookPattern: 'question',
      structurePattern: 'hook-demo-cta',
      ctaPattern: 'visit',
      paceTag: 'medium',
      moodTag: 'warm',
    });
    const text = JSON.stringify(video);
    for (const hidden of [
      'Secret script words',
      'secret',
      'Overlay words',
      'transcript',
      'overlayTimeline',
      'contract 7',
      'internal note',
      'example.test',
      'categoryReview',
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it('keeps what the Create banner, the player and the actions use', async () => {
    const video = await getLibraryVideo({ db, storage }, 'lib_1');
    expect(video).toMatchObject({
      id: 'lib_1',
      title: 'Sourdough morning',
      durationSec: 21,
      aspectRatio: '9:16',
      category: { slug: 'food', name: 'Food' },
      allowedModes: ['TEMPLATE', 'INSPIRE'],
      thumbnailUrl: 'https://signed.test/library/a/b.jpg',
      previewExpiresInSec: 600,
    });
    expect(video.previewUrl).toContain('https://signed.test/library/');
  });
});
