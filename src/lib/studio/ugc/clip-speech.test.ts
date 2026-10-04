import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineDeps } from '../pipeline/deps';
import { clipSpeaks, speechAssetIdOf, timeClipSpeech } from './clip-speech';

const ensureWordTiming = vi.hoisted(() => vi.fn());
vi.mock('../pipeline/word-timing', async (original) => ({
  ...(await original<typeof import('../pipeline/word-timing')>()),
  ensureWordTiming,
}));

describe('speech assets (21.4)', () => {
  it('an actor clip speaks; a degraded actor shot or any other shot uses its narration', () => {
    const actor = { visualTreatment: 'UGC_ACTOR', voiceAssetId: null, assetId: 'clip' };
    expect(clipSpeaks(actor)).toBe(true);
    expect(speechAssetIdOf(actor)).toBe('clip');
    const degraded = { ...actor, voiceAssetId: 'voice' };
    expect(clipSpeaks(degraded)).toBe(false);
    expect(speechAssetIdOf(degraded)).toBe('voice');
    expect(
      speechAssetIdOf({ visualTreatment: 'AI_CLIP', voiceAssetId: null, assetId: 'a' }),
    ).toBeNull();
    expect(
      speechAssetIdOf({ visualTreatment: 'UGC_ACTOR', voiceAssetId: null, assetId: null }),
    ).toBeNull();
  });
});

describe('timeClipSpeech', () => {
  const updates: unknown[] = [];
  let words: Array<{ text: string; startSec: number; endSec: number }> = [];

  function deps(shot: Record<string, unknown> | null, probe = 8): PipelineDeps {
    const metadata = () => ({ wordTiming: { status: 'ok', words, providerId: 'assemblyai' } });
    return {
      db: {
        videoShot: { findUnique: vi.fn(async () => shot) },
        videoAsset: {
          findFirst: vi.fn(async () => ({
            id: 'clip',
            s3Bucket: 'b',
            s3Key: 'k',
            metadata: metadata(),
          })),
          findUnique: vi.fn(async () => ({ metadata: metadata() })),
          update: vi.fn(async (args: unknown) => {
            updates.push(args);
            return {};
          }),
        },
      },
      media: { probe: vi.fn(async () => ({ durationSec: probe })) },
      storage: { signedUrl: vi.fn(async () => 'https://signed/clip.mp4') },
      logger: { warn: vi.fn() },
    } as unknown as PipelineDeps;
  }

  beforeEach(() => {
    updates.length = 0;
    ensureWordTiming.mockReset();
  });

  const actorShot = {
    visualTreatment: 'UGC_ACTOR',
    voiceAssetId: null,
    assetId: 'clip',
    durationSec: 8,
  };
  const input = { shotId: 's1', organisationId: 'org', planTier: 'STANDARD' as const };

  it('transcribes the clip and stores a fit for a line that ends inside the shot', async () => {
    words = [
      { text: 'Honestly', startSec: 0.3, endSec: 0.8 },
      { text: 'love', startSec: 6.9, endSec: 7.4 },
    ];
    const fit = await timeClipSpeech(deps(actorShot), input);
    expect(ensureWordTiming).toHaveBeenCalledWith(expect.anything(), {
      assetId: 'clip',
      organisationId: 'org',
      planTier: 'STANDARD',
    });
    expect(fit).toMatchObject({ strategy: 'fits', voiceSec: 7.4, shotSec: 8 });
    expect(JSON.stringify(updates[0])).toContain('"fit":{"strategy":"fits"');
  });

  it('a line past the shot is recorded as an overrun (never re-voiced)', async () => {
    words = [{ text: 'end', startSec: 7.5, endSec: 8.6 }];
    const fit = await timeClipSpeech(deps(actorShot), input);
    expect(fit?.strategy).toBe('trim');
    expect(fit?.speed).toBeUndefined();
  });

  it('without word timing the clip length is measured', async () => {
    words = [];
    const d = deps(actorShot, 8);
    expect(await timeClipSpeech(d, input)).toMatchObject({ strategy: 'fits', voiceSec: 8 });
    expect(d.media.probe).toHaveBeenCalled();
  });

  it('does nothing for a degraded or other shot', async () => {
    expect(await timeClipSpeech(deps({ ...actorShot, voiceAssetId: 'v' }), input)).toBeNull();
    expect(await timeClipSpeech(deps(null), input)).toBeNull();
    expect(ensureWordTiming).not.toHaveBeenCalled();
  });
});
