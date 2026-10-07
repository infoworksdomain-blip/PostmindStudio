import sharp from 'sharp';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, ValidationError } from '../../errors';
import type { StockHit } from '../images/stock';
import type { ProviderRunDeps } from '../pipeline/provider-run';

vi.mock('../pipeline/provider-run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pipeline/provider-run')>();
  return { ...actual, runProvider: vi.fn() };
});

import { runProvider } from '../pipeline/provider-run';
import {
  checkStockRelevance,
  createStockScreen,
  MAX_RELEVANCE_CHECKS_PER_RUN,
  parseRelevance,
  relevancePrompt,
  RELEVANCE_SYSTEM_PROMPT,
  RELEVANCE_THUMB_PX,
} from './image-relevance';

// 25.x — stock candidates must plausibly fit the slide before one is used.

const runProviderMock = runProvider as unknown as ReturnType<typeof vi.fn>;
const scope = { organisationId: 'org-1', projectId: 'proj-1', planTier: 'STANDARD' as const };
let jpeg: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  jpeg = new Uint8Array(
    await sharp({
      create: { width: 1280, height: 853, channels: 3, background: { r: 200, g: 150, b: 90 } },
    })
      .jpeg()
      .toBuffer(),
  );
});

function hit(id: string): StockHit {
  return {
    provider: 'pixabay',
    providerImageId: id,
    imageUrl: `https://cdn.pixabay.example/${id}.jpg`,
    width: 1280,
    height: 853,
    alt: null,
    pageUrl: null,
    attribution: null,
    storable: true,
  };
}

/** fetch stub: every URL is the test JPEG, except those listed as failing (HTTP 404). */
function fetchImages(failing: string[] = []) {
  return vi.fn(async (url: string) =>
    failing.some((f) => url.includes(f))
      ? new Response('missing', { status: 404 })
      : new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
  ) as unknown as typeof fetch;
}

function deps(fetchImpl: typeof fetch = fetchImages()) {
  return { providers: {} as unknown as ProviderRunDeps, fetchImpl, logger: { warn: vi.fn() } };
}

function modelSays(answers: Array<'yes' | 'no'>) {
  runProviderMock.mockResolvedValue({
    providerJobRowId: 'job-1',
    output: {
      metadata: { json: { photos: answers.map((answer, i) => ({ photo: i + 1, answer })) } },
    },
  });
}

const input = {
  query: 'gym coach training client',
  business: 'Gym — Fitness',
  hits: [hit('a'), hit('b'), hit('c')],
};

beforeEach(() => {
  runProviderMock.mockReset();
});

describe('parseRelevance', () => {
  it('one verdict per photo, in photo order', () => {
    expect(
      parseRelevance(
        {
          photos: [
            { photo: 2, answer: 'yes' },
            { photo: 1, answer: 'no' },
          ],
        },
        2,
      ),
    ).toEqual([false, true]);
  });

  it.each([
    [{ photos: [{ photo: 1, answer: 'yes' }] }, 2],
    [
      {
        photos: [
          { photo: 1, answer: 'yes' },
          { photo: 1, answer: 'no' },
        ],
      },
      2,
    ],
    [{ photos: [{ photo: 1, answer: 'maybe' }] }, 1],
    [{ photos: [{ photo: 3, answer: 'yes' }] }, 1],
    [null, 1],
  ])('rejects a malformed answer %j', (json, count) => {
    expect(() => parseRelevance(json, count)).toThrow(ValidationError);
  });
});

describe('checkStockRelevance', () => {
  it('sends small JPEG thumbnails in ONE light slide_image_check call', async () => {
    modelSays(['no', 'yes', 'no']);

    const verdict = await checkStockRelevance(deps(), scope, input);

    expect(verdict).toEqual({ status: 'checked', relevant: [false, true, false] });
    expect(runProviderMock).toHaveBeenCalledTimes(1);
    const request = runProviderMock.mock.calls[0]?.[0].request as {
      task: string;
      images: Array<{ mediaType: string; data: string }>;
      prompt: string;
      system: string;
      maxTokens: number;
    };
    expect(request.task).toBe('slide_image_check');
    expect(request.system).toBe(RELEVANCE_SYSTEM_PROMPT);
    expect(request.maxTokens).toBeLessThanOrEqual(120);
    expect(request.images).toHaveLength(3);
    const meta = await sharp(Buffer.from(request.images[0]!.data, 'base64')).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(RELEVANCE_THUMB_PX);
    expect(request.prompt).toContain('gym coach training client');
    expect(request.prompt).toContain('Business: Gym — Fitness');
  });

  it('a picture that cannot be downloaded counts as "no"; the rest are still checked', async () => {
    modelSays(['yes', 'yes']);
    const verdict = await checkStockRelevance(deps(fetchImages(['/a.jpg'])), scope, input);
    expect(verdict).toEqual({ status: 'checked', relevant: [false, true, true] });
    expect(runProviderMock.mock.calls[0]?.[0].request.images).toHaveLength(2);
  });

  it('skipped when no picture can be read, or when the model is down', async () => {
    expect(await checkStockRelevance(deps(fetchImages(['.jpg'])), scope, input)).toMatchObject({
      status: 'skipped',
    });
    expect(runProviderMock).not.toHaveBeenCalled();

    runProviderMock.mockRejectedValue(
      new ProviderError('anthropic', 'server_error', 'overloaded', true),
    );
    expect(await checkStockRelevance(deps(), scope, input)).toMatchObject({ status: 'skipped' });
  });

  it('skipped when the answer is malformed (never guesses)', async () => {
    modelSays(['yes']); // 1 answer for 3 photos
    expect(await checkStockRelevance(deps(), scope, input)).toMatchObject({ status: 'skipped' });
  });
});

describe('createStockScreen', () => {
  it('keeps only relevant hits, in order', async () => {
    modelSays(['no', 'yes', 'yes']);
    const screen = createStockScreen(deps(), scope, 'Gym');
    expect((await screen('q', input.hits)).map((h) => h.providerImageId)).toEqual(['b', 'c']);
  });

  it('every hit rejected → none (the caller tries the next source / generation)', async () => {
    modelSays(['no', 'no', 'no']);
    const screen = createStockScreen(deps(), scope, 'Gym');
    expect(await screen('q', input.hits)).toEqual([]);
  });

  it('an outage accepts the best candidate (hits unchanged) and logs', async () => {
    runProviderMock.mockRejectedValue(new ProviderError('anthropic', 'auth', 'bad key', false));
    const d = deps();
    const screen = createStockScreen(d, scope, 'Gym');
    expect((await screen('q', input.hits)).map((h) => h.providerImageId)).toEqual(['a', 'b', 'c']);
    expect(d.logger.warn).toHaveBeenCalled();
  });

  it('stops checking after the per-run cap (cost bound) and passes hits unchecked', async () => {
    modelSays(['no', 'no', 'no']);
    const screen = createStockScreen(deps(), scope, 'Gym', 2);
    expect(await screen('q', input.hits)).toEqual([]);
    expect(await screen('q', input.hits)).toEqual([]);
    expect(await screen('q', input.hits)).toHaveLength(3);
    expect(runProviderMock).toHaveBeenCalledTimes(2);
    expect(MAX_RELEVANCE_CHECKS_PER_RUN).toBeLessThanOrEqual(12);
  });

  it('no hits → no call', async () => {
    const screen = createStockScreen(deps(), scope, 'Gym');
    expect(await screen('q', [])).toEqual([]);
    expect(runProviderMock).not.toHaveBeenCalled();
  });
});

describe('relevancePrompt', () => {
  it('names the slide need and the business, and asks yes/no per photo', () => {
    const prompt = relevancePrompt({
      query: 'florist van delivery',
      business: 'Florist',
      count: 2,
    });
    expect(prompt).toContain('numbered 1 to 2');
    expect(prompt).toContain('florist van delivery');
    expect(prompt).toContain('"yes"');
  });
});
