import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineDeps } from './deps';
import { ALIGNMENT_PROVIDER_ID, ensureWordTiming } from './word-timing';

// 23.2 — narration with an ElevenLabs alignment is not transcribed; everything else still is.

const { runProvider } = vi.hoisted(() => ({ runProvider: vi.fn() }));
vi.mock('./provider-run', () => ({ runProvider }));

const ALIGNED = [
  { text: 'Fresh', startSec: 0, endSec: 0.4 },
  { text: 'AheadAI', startSec: 0.5, endSec: 1 },
];

function deps(asset: Record<string, unknown>, voiceoverText = 'Fresh AheadAI') {
  const update = vi.fn().mockResolvedValue({});
  const d = {
    db: {
      videoAsset: { findFirst: vi.fn().mockResolvedValue(asset), update },
      videoShot: {
        findFirst: vi.fn().mockResolvedValue({ voiceoverText }),
        findUnique: vi.fn().mockResolvedValue({ script: { language: 'en-GB' } }),
      },
      videoProject: { findUnique: vi.fn().mockResolvedValue({ language: 'en-GB' }) },
    },
    storage: { signedUrl: vi.fn().mockResolvedValue('https://signed.invalid/a') },
    logger: { warn: vi.fn() },
  } as unknown as PipelineDeps;
  return { d, update };
}

const asset = {
  id: 'a1',
  projectId: 'p1',
  shotId: 's1',
  s3Bucket: 'b',
  s3Key: 'k',
  durationSec: 2,
};

beforeEach(() => runProvider.mockReset());

describe('ensureWordTiming with a TTS alignment', () => {
  it('uses the alignment and never calls the transcription provider', async () => {
    const { d, update } = deps({ ...asset, metadata: { alignedWords: ALIGNED } });
    const timing = await ensureWordTiming(d, {
      assetId: 'a1',
      organisationId: 'o1',
      planTier: 'STANDARD',
    });
    expect(runProvider).not.toHaveBeenCalled();
    expect(timing).toEqual({ status: 'ok', words: ALIGNED, providerId: ALIGNMENT_PROVIDER_ID });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: {
        metadata: {
          alignedWords: ALIGNED,
          wordTiming: { status: 'ok', words: ALIGNED, providerId: ALIGNMENT_PROVIDER_ID },
        },
      },
    });
  });

  it('still re-spells to the script (the alignment words already match it one to one)', async () => {
    const { d } = deps({ ...asset, metadata: { alignedWords: ALIGNED } }, 'Fresh AheadAI');
    const timing = await ensureWordTiming(d, {
      assetId: 'a1',
      organisationId: 'o1',
      planTier: 'STANDARD',
    });
    expect(timing?.status === 'ok' && timing.words.map((w) => w.text)).toEqual([
      'Fresh',
      'AheadAI',
    ]);
  });

  it.each([
    ['no alignment (actor clip, upload)', {}],
    ['an invalid alignment', { alignedWords: [{ text: 'x' }] }],
  ])('transcribes with AssemblyAI when there is %s', async (_label, metadata) => {
    runProvider.mockResolvedValue({
      decision: { providerId: 'assemblyai' },
      output: { metadata: { words: [{ text: 'Fresh', startSec: 0, endSec: 0.4 }] } },
    });
    const { d } = deps({ ...asset, metadata });
    const timing = await ensureWordTiming(d, {
      assetId: 'a1',
      organisationId: 'o1',
      planTier: 'STANDARD',
    });
    expect(runProvider).toHaveBeenCalledTimes(1);
    expect(runProvider.mock.calls[0]?.[0]).toMatchObject({
      need: { kind: 'capability', capability: 'transcription' },
    });
    expect(timing).toMatchObject({ status: 'ok', providerId: 'assemblyai' });
  });
});
