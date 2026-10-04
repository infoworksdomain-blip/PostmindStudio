import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { generateViolations, tierQuota } from '../services/plan-quotas';
import { allowanceUnitsOf, UGC_VIDEO_ALLOWANCE_UNITS } from './allowance';
import { newUgcStyle } from './style';

// BACKLOG 21.4 (operator decision 2026-10-04): a UGC actor video uses UGC_VIDEO_ALLOWANCE_UNITS of
// the included videos (or of a pack); an ordinary video uses one.

const ugcMeta = { ugc: newUgcStyle({}, 1) } as unknown as Prisma.JsonObject;
const formats = [{ platform: 'tiktok', aspectRatio: '9:16', duration: 30 }];

describe('UGC allowance units (21.4)', () => {
  it('a UGC video uses 2 videos, any other video 1', () => {
    expect(UGC_VIDEO_ALLOWANCE_UNITS).toBe(2);
    expect(allowanceUnitsOf(ugcMeta)).toBe(2);
    expect(allowanceUnitsOf({})).toBe(1);
    expect(allowanceUnitsOf(null)).toBe(1);
  });

  it('needs room for both: with one video left a UGC video is over the allowance', () => {
    const quota = { ...tierQuota('STANDARD', {}), shortVideos: 8 };
    const base = { alreadyCounted: false, quota, tier: 'STANDARD' as const };
    const ugc = { sourceType: 'BRIEF', targetFormats: formats, metadata: ugcMeta };
    const plain = { sourceType: 'BRIEF', targetFormats: formats, metadata: {} };
    expect(generateViolations({ ...base, project: ugc, usage: { short: 6, long: 0 } })).toEqual([]);
    expect(
      generateViolations({ ...base, project: ugc, usage: { short: 7, long: 0 } }).map(
        (v) => v.code,
      ),
    ).toEqual(['short_quota']);
    expect(generateViolations({ ...base, project: plain, usage: { short: 7, long: 0 } })).toEqual(
      [],
    );
  });
});
