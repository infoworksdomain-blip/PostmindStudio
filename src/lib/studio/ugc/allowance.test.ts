import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { generateViolations, tierQuota } from '../services/plan-quotas';
import { allowanceQuartersOf, UGC_VIDEO_ALLOWANCE_UNITS, UGC_VIDEO_QUARTERS } from './allowance';
import { newUgcStyle } from './style';

// BACKLOG 21.4 (operator decision 2026-10-04): a UGC actor video uses UGC_VIDEO_ALLOWANCE_UNITS of
// the included videos (or of a pack); an ordinary video uses one. 23.3 (operator 2026-10-06):
// counted in quarters of a video; carousels, slideshows, wall of text and hook + demo use ¼.

const ugcMeta = { ugc: newUgcStyle({}, 1) } as unknown as Prisma.JsonObject;
const formats = [{ platform: 'tiktok', aspectRatio: '9:16', duration: 30 }];

describe('allowance quarters per format (21.4, 23.3)', () => {
  it('a UGC video uses 2 videos (8 quarters), any other AI video 1 (4 quarters)', () => {
    expect(UGC_VIDEO_ALLOWANCE_UNITS).toBe(2);
    expect(UGC_VIDEO_QUARTERS).toBe(8);
    expect(allowanceQuartersOf({ sourceType: 'BRIEF', metadata: ugcMeta })).toBe(8);
    expect(allowanceQuartersOf({ sourceType: 'BRIEF', metadata: {} })).toBe(4);
    expect(allowanceQuartersOf({ metadata: null })).toBe(4);
    expect(allowanceQuartersOf({ sourceType: 'URL' })).toBe(4);
  });

  it('carousels, slideshows, wall of text and hook + demo are quick posts (1 quarter)', () => {
    for (const sourceType of ['CAROUSEL', 'SLIDESHOW', 'WALL_OF_TEXT', 'HOOK_DEMO'])
      expect(allowanceQuartersOf({ sourceType, metadata: {} })).toBe(1);
    // Recognised from the stored document too (a project read without its sourceType).
    expect(allowanceQuartersOf({ metadata: { carousel: { version: 1 } } })).toBe(1);
    expect(allowanceQuartersOf({ metadata: { wallOfText: { text: 'x' } } })).toBe(1);
    expect(allowanceQuartersOf({ metadata: { hookDemo: { hookLine: 'x' } } })).toBe(1);
    // A non-object marker is not a document.
    expect(allowanceQuartersOf({ metadata: { carousel: 'yes' } })).toBe(4);
  });

  it('needs room for both: with one video left a UGC video is over the allowance', () => {
    const quota = { ...tierQuota('STANDARD', {}), shortVideos: 8 };
    const base = { alreadyCounted: false, quota, tier: 'STANDARD' as const };
    const ugc = { sourceType: 'BRIEF', targetFormats: formats, metadata: ugcMeta };
    const plain = { sourceType: 'BRIEF', targetFormats: formats, metadata: {} };
    // usage is in quarters: 24 = 6 videos, 28 = 7 videos.
    expect(generateViolations({ ...base, project: ugc, usage: { short: 24, long: 0 } })).toEqual(
      [],
    );
    expect(
      generateViolations({ ...base, project: ugc, usage: { short: 28, long: 0 } }).map(
        (v) => v.code,
      ),
    ).toEqual(['short_quota']);
    expect(generateViolations({ ...base, project: plain, usage: { short: 28, long: 0 } })).toEqual(
      [],
    );
  });

  it('a quick post fits in the last quarter; an AI video needs a whole video', () => {
    const quota = { ...tierQuota('STANDARD', {}), shortVideos: 8 };
    const base = { alreadyCounted: false, quota, tier: 'STANDARD' as const };
    const carousel = { sourceType: 'CAROUSEL', targetFormats: [], metadata: {} };
    const plain = { sourceType: 'BRIEF', targetFormats: formats, metadata: {} };
    // 31 of 32 quarters used (7.75 videos).
    expect(
      generateViolations({ ...base, project: carousel, usage: { short: 31, long: 0 } }),
    ).toEqual([]);
    const over = generateViolations({ ...base, project: plain, usage: { short: 31, long: 0 } });
    expect(over.map((v) => v.code)).toEqual(['short_quota']);
    expect(over[0]?.message).toContain('7.75 have been used');
    expect(
      generateViolations({ ...base, project: carousel, usage: { short: 32, long: 0 } }).map(
        (v) => v.code,
      ),
    ).toEqual(['short_quota']);
  });
});
