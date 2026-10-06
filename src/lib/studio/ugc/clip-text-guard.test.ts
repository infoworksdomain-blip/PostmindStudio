import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoProviderAvailableError, ValidationError } from '../../errors';
import type { PipelineDeps } from '../pipeline/deps';
import type { ProviderRunResult } from '../pipeline/provider-run';
import {
  CLIP_TEXT_FRAME_WIDTH,
  CLIP_TEXT_QUESTION,
  clipTextFrameTimes,
  clipTextGuardEnabled,
  clipTextOf,
  clipTextPrompt,
  detectBurnedInText,
  evaluateClipText,
  guardActorClip,
  parseClipTextAnswer,
  REGENERATED_FOR_TEXT,
  type ClipTextTarget,
} from './clip-text-guard';

// BACKLOG 21.4c — the burned-in text check on UGC actor clips: frames → one vision call → yes/no
// per frame; text → one regeneration; text again → kept for review (quality gate warning).

const runProvider = vi.hoisted(() => vi.fn());
vi.mock('../pipeline/provider-run', async (original) => ({
  ...(await original<typeof import('../pipeline/provider-run')>()),
  runProvider,
}));

/** A runProvider that fails (the router's errors: no provider, outage, cost cap…). */
const rejectWith = (error: Error) =>
  runProvider.mockImplementation(async () => {
    throw error;
  });

const answer = (...answers: Array<'yes' | 'no'>) => ({
  frames: answers.map((a, i) => ({ frame: i + 1, answer: a })),
});

function visionRun(json: unknown): ProviderRunResult {
  return {
    decision: {} as ProviderRunResult['decision'],
    providerJobRowId: 'pj-vision',
    output: { metadata: { json, model: 'claude', costPence: 2 } },
  };
}

function deps(config: { clipTextGuard?: boolean } = {}) {
  const metadata = new Map<string, Record<string, unknown>>([
    ['a1', { speech: 'clip' }],
    ['a2', { speech: 'clip', regeneratedFrom: 'a1' }],
  ]);
  const frameJpeg = vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  const d = {
    db: {
      videoAsset: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          metadata.has(where.id)
            ? { s3Bucket: 'assets', s3Key: `${where.id}.mp4`, metadata: metadata.get(where.id) }
            : null,
        ),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: { metadata: unknown } }) => {
            metadata.set(where.id, data.metadata as Record<string, unknown>);
            return {};
          },
        ),
      },
      providerJob: { findUnique: vi.fn(async () => ({ costPence: 2 })) },
    },
    storage: { signedUrl: vi.fn(async (_b: string, key: string) => `https://signed.test/${key}`) },
    media: { frameJpeg },
    logger: pino({ level: 'silent' }),
    config: { assetsBucket: 'assets', rendersBucket: 'renders', ...config },
  } as unknown as PipelineDeps;
  return { d, metadata, frameJpeg };
}

const target: ClipTextTarget = {
  organisationId: 'org-1',
  projectId: 'p1',
  shotId: 's3',
  planTier: 'STANDARD',
  durationSec: 8,
  assetId: 'a1',
};

// Braces: a function returned from beforeEach is run as its teardown (it would call the mock).
beforeEach(() => {
  runProvider.mockReset();
});

describe('clip text answer parsing (21.4c)', () => {
  it('returns the frames answered "yes"', () => {
    expect(parseClipTextAnswer(answer('no', 'yes', 'yes'), 3)).toEqual([2, 3]);
    expect(parseClipTextAnswer(answer('no', 'no', 'no'), 3)).toEqual([]);
  });

  it('is strict: wrong count, numbering or answer words are errors, never guesses', () => {
    expect(() => parseClipTextAnswer(answer('no', 'no'), 3)).toThrow(ValidationError);
    expect(() =>
      parseClipTextAnswer(
        {
          frames: [
            { frame: 1, answer: 'no' },
            { frame: 1, answer: 'no' },
          ],
        },
        2,
      ),
    ).toThrow(ValidationError);
    expect(() => parseClipTextAnswer({ frames: [{ frame: 1, answer: 'maybe' }] }, 1)).toThrow(
      ValidationError,
    );
    expect(() => parseClipTextAnswer({ verdict: 'ALLOW' }, 1)).toThrow(ValidationError);
    expect(() => parseClipTextAnswer(null, 1)).toThrow(ValidationError);
  });

  it('asks the operator question and tells the model to ignore text that is part of the scene', () => {
    const prompt = clipTextPrompt(3);
    expect(prompt).toContain(CLIP_TEXT_QUESTION);
    expect(CLIP_TEXT_QUESTION).toContain('ignore text that is physically part of the scene');
    expect(prompt).toMatch(/printed on an object in the scene/);
  });

  it('takes three frames across the clip, the last near its end', () => {
    expect(clipTextFrameTimes(8)).toEqual([2, 4.4, 6.8]);
    expect(clipTextFrameTimes(0)).toEqual([2, 4.4, 6.8]);
  });

  it('is on by default and off with STUDIO_CLIP_TEXT_GUARD=false or config.clipTextGuard', () => {
    expect(clipTextGuardEnabled({}, {})).toBe(true);
    expect(clipTextGuardEnabled({}, { STUDIO_CLIP_TEXT_GUARD: 'true' })).toBe(true);
    expect(clipTextGuardEnabled({}, { STUDIO_CLIP_TEXT_GUARD: 'false' })).toBe(false);
    expect(clipTextGuardEnabled({ clipTextGuard: false }, {})).toBe(false);
    expect(clipTextGuardEnabled({ clipTextGuard: true }, { STUDIO_CLIP_TEXT_GUARD: 'false' })).toBe(
      true,
    );
  });
});

describe('detectBurnedInText (21.4c)', () => {
  it('sends the stored clip’s frames in one vision call and reports text with its cost', async () => {
    const { d, frameJpeg } = deps();
    runProvider.mockResolvedValue(visionRun(answer('no', 'yes', 'no')));
    const result = await detectBurnedInText(d, target);
    expect(result).toEqual({ status: 'text', frames: 3, framesWithText: [2], costPence: 2 });
    expect(frameJpeg).toHaveBeenCalledTimes(3);
    expect(frameJpeg).toHaveBeenCalledWith('https://signed.test/a1.mp4', 2, CLIP_TEXT_FRAME_WIDTH);
    expect(runProvider).toHaveBeenCalledTimes(1);
    const call = runProvider.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      need: { kind: 'capability', capability: 'text_generation' },
      planTier: 'STANDARD',
      request: {
        capability: 'text_generation',
        organisationId: 'org-1',
        projectId: 'p1',
        shotId: 's3',
        outputSchema: expect.any(Object),
      },
    });
    expect(call.request.images).toHaveLength(3);
    expect(call.request.images[0]).toMatchObject({ mediaType: 'image/jpeg' });
  });

  it('in-scene text answered "no" is clean', async () => {
    const { d } = deps();
    runProvider.mockResolvedValue(visionRun(answer('no', 'no', 'no')));
    expect(await detectBurnedInText(d, target)).toMatchObject({
      status: 'clean',
      framesWithText: [],
    });
  });

  it.each([
    ['no vision provider', () => rejectWith(new NoProviderAvailableError('x'))],
    ['a malformed answer', () => runProvider.mockResolvedValue(visionRun({ verdict: 'ALLOW' }))],
    ['a provider outage', () => rejectWith(new Error('503 overloaded'))],
  ])('%s → skipped, never thrown', async (_label, arrange) => {
    const { d } = deps();
    arrange();
    expect(await detectBurnedInText(d, target)).toMatchObject({ status: 'skipped' });
  });

  it('a frame grab failure → skipped without a vision call', async () => {
    const { d, frameJpeg } = deps();
    frameJpeg.mockRejectedValueOnce(new ValidationError('ffmpeg produced no frame'));
    expect(await detectBurnedInText(d, target)).toMatchObject({ status: 'skipped' });
    expect(runProvider).not.toHaveBeenCalled();
  });
});

describe('guardActorClip (21.4c)', () => {
  it('no text → no regeneration; the check is recorded on the clip', async () => {
    const { d, metadata } = deps();
    runProvider.mockResolvedValue(visionRun(answer('no', 'no', 'no')));
    const regenerate = vi.fn(async () => 'a2');
    expect(await guardActorClip(d, target, regenerate)).toBe('a1');
    expect(regenerate).not.toHaveBeenCalled();
    expect(clipTextOf(metadata.get('a1') as never)).toMatchObject({ attempt: 1, status: 'clean' });
  });

  it('text → exactly one regeneration; a clean retry is kept', async () => {
    const { d, metadata } = deps();
    runProvider
      .mockResolvedValueOnce(visionRun(answer('yes', 'yes', 'no')))
      .mockResolvedValueOnce(visionRun(answer('no', 'no', 'no')));
    const regenerate = vi.fn(async () => 'a2');
    expect(await guardActorClip(d, target, regenerate)).toBe('a2');
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(regenerate).toHaveBeenCalledWith(REGENERATED_FOR_TEXT);
    expect(clipTextOf(metadata.get('a1') as never)).toMatchObject({
      status: 'text',
      framesWithText: [1, 2],
    });
    expect(clipTextOf(metadata.get('a2') as never)).toMatchObject({ attempt: 2, status: 'clean' });
  });

  it('text again → the retry is kept with its "text" record, no third attempt', async () => {
    const { d, metadata } = deps();
    runProvider.mockResolvedValue(visionRun(answer('yes', 'no', 'no')));
    const regenerate = vi.fn(async () => 'a2');
    expect(await guardActorClip(d, target, regenerate)).toBe('a2');
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(runProvider).toHaveBeenCalledTimes(2);
    expect(clipTextOf(metadata.get('a2') as never)).toMatchObject({ attempt: 2, status: 'text' });
  });

  it('a failed regeneration keeps the first clip (flagged) and does not throw', async () => {
    const { d, metadata } = deps();
    runProvider.mockResolvedValue(visionRun(answer('yes', 'yes', 'yes')));
    const regenerate = vi.fn(async () => {
      throw new Error('cost cap reached');
    });
    expect(await guardActorClip(d, target, regenerate)).toBe('a1');
    expect(clipTextOf(metadata.get('a1') as never)).toMatchObject({ status: 'text' });
  });

  it('a skipped check is not a reason to regenerate', async () => {
    const { d, metadata } = deps();
    rejectWith(new NoProviderAvailableError('none'));
    const regenerate = vi.fn(async () => 'a2');
    expect(await guardActorClip(d, target, regenerate)).toBe('a1');
    expect(regenerate).not.toHaveBeenCalled();
    expect(clipTextOf(metadata.get('a1') as never)).toMatchObject({ status: 'skipped' });
  });

  it('flag off → no frames, no vision call, nothing recorded', async () => {
    const { d, frameJpeg, metadata } = deps({ clipTextGuard: false });
    const regenerate = vi.fn(async () => 'a2');
    expect(await guardActorClip(d, target, regenerate)).toBe('a1');
    expect(frameJpeg).not.toHaveBeenCalled();
    expect(runProvider).not.toHaveBeenCalled();
    expect(clipTextOf(metadata.get('a1') as never)).toBeNull();
  });
});

describe('evaluateClipText (21.4c quality gate)', () => {
  it('warns (not fails) with the shot numbers whose kept clip has text', () => {
    const check = evaluateClipText([
      { number: 1, clipText: { attempt: 1, status: 'clean' } },
      { number: 3, clipText: { attempt: 2, status: 'text', framesWithText: [2] } },
    ]);
    expect(check).toMatchObject({
      code: 'clip_text',
      status: 'warning',
      severity: 'info',
      detailKey: 'clipTextBurnedIn',
      detailParams: { count: 1, shots: '3' },
    });
  });

  it('is absent when no kept clip has text (skipped checks included)', () => {
    expect(
      evaluateClipText([
        { number: 1, clipText: { attempt: 1, status: 'skipped', reason: 'x' } },
        { number: 2, clipText: null },
      ]),
    ).toBeNull();
  });
});
