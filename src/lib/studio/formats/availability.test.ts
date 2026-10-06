import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { canMakeHookDemoCard, hookDemoReadiness } from './availability';

// 22.1 × 22.4 / 22.5 — Blitz and automations offer a hook + demo card only when the business has
// a ready demo video AND a FOOTAGE-licensed library reaction clip (no paid clip before a keep).

function db(demos: number, clips: number) {
  const libraryRow = {
    id: 'lib-1',
    s3Bucket: 'library',
    s3Key: 'reaction.mp4',
    durationSec: 6,
    aspectRatio: '9:16',
  };
  return {
    videoUpload: { count: vi.fn(async () => demos) },
    videoLibraryItem: { findMany: vi.fn(async () => (clips ? [libraryRow] : [])) },
  } as unknown as Pick<PrismaClient, 'videoUpload' | 'videoLibraryItem'>;
}

const scope = { organisationId: 'org', businessId: 'biz', now: new Date('2026-10-06') };

describe('hookDemoReadiness', () => {
  it('offers the card with a demo video and a licensed library hook clip', async () => {
    const r = await hookDemoReadiness(db(1, 1), scope);
    expect(r).toEqual({ demoVideo: true, libraryHook: true });
    expect(canMakeHookDemoCard(r)).toBe(true);
  });

  it('skips it without a demo video (and does not look for a clip)', async () => {
    const fake = db(0, 1);
    const r = await hookDemoReadiness(fake, scope);
    expect(canMakeHookDemoCard(r)).toBe(false);
    expect(fake.videoLibraryItem.findMany).not.toHaveBeenCalled();
    expect(fake.videoUpload.count).toHaveBeenCalledWith({
      where: { organisationId: 'org', businessId: 'biz', kind: 'DEMO_VIDEO', state: 'READY' },
    });
  });

  it('skips it without a library hook clip (a generated one would be paid for unkept)', async () => {
    expect(canMakeHookDemoCard(await hookDemoReadiness(db(2, 0), scope))).toBe(false);
  });
});
