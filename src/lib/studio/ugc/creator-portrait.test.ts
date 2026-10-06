import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { fakePng } from '../../../../test/helpers/png';
import type { ProviderRunDeps, ProviderRunResult } from '../pipeline/provider-run';
import {
  creatorPortraitKey,
  creatorPortraitPrompt,
  generateCreatorPortrait,
  sniffPortraitType,
} from './creator-portrait';
import { checkRealPersonRequest } from './real-person';
import { creatorDescription } from './style';

// BACKLOG 22.3 — a creator's portrait: the same IMAGE_STILL route and fictional-person prompt
// rules as a project's actor portrait (21.4a), copied out of the 30-day provider outputs to the
// creator's own key so it is kept. Provider calls are mocked; no real API is called.

const runProvider = vi.hoisted(() => vi.fn());
vi.mock('../pipeline/provider-run', async (original) => ({
  ...(await original<typeof import('../pipeline/provider-run')>()),
  runProvider,
}));

beforeEach(() => runProvider.mockReset());

function run(metadata: Record<string, unknown>, url?: string): ProviderRunResult {
  return {
    decision: { providerId: 'openai' },
    providerJobRowId: 'job-1',
    output: { ...(url && { url }), metadata },
  } as unknown as ProviderRunResult;
}

function deps() {
  const { storage, objects } = memoryStorage();
  const providers = {
    db: { providerJob: { findUnique: vi.fn(async () => ({ costPence: 5 })) } },
    fetch: vi.fn(),
  } as unknown as ProviderRunDeps;
  return { d: { providers, storage, bucket: 'assets' }, storage, objects, providers };
}

const input = {
  organisationId: 'org-1',
  creatorId: 'cr-1',
  planTier: 'STANDARD' as const,
  description: 'a woman around thirty, short curly hair',
  setting: 'kitchen' as const,
};

describe('creator portrait prompt and description', () => {
  it('asks for a fictional person from the look text, with optional adjustments', () => {
    const prompt = creatorPortraitPrompt({ ...input, instructions: '  a  bigger smile ' });
    expect(prompt).toContain(
      'a fictional person who does not exist: a woman around thirty, short curly hair, in a bright, lived-in home kitchen.',
    );
    expect(prompt).toContain('not anyone famous and not any real, identifiable person');
    expect(prompt).toMatch(/Adjustments: a bigger smile\.$/);
    expect(checkRealPersonRequest(prompt).refused).toBe(false);
    expect(creatorPortraitPrompt(input)).not.toContain('Adjustments');
  });

  it('builds the look from presets and notes, or from the seed when there are no notes', () => {
    expect(
      creatorDescription({
        gender: 'man',
        ageRange: '45-60',
        appearance: ' grey beard,  flat cap. ',
        seed: 1,
      }),
    ).toBe('a man in their fifties, grey beard, flat cap');
    expect(
      creatorDescription({ gender: 'woman', ageRange: '18-24', appearance: null, seed: 7 }),
    ).toMatch(/^a woman in their early twenties with .+, wearing .+$/);
  });

  it('sniffs PNG and JPEG only, and keys portraits under the creator', () => {
    expect(sniffPortraitType(fakePng(10, 10))).toBe('image/png');
    expect(sniffPortraitType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffPortraitType(new TextEncoder().encode('RIFF....WEBP'))).toBeNull();
    expect(creatorPortraitKey('org-1', 'cr-1', 'png')).toMatch(
      /^orgs\/org-1\/creators\/cr-1\/.+\.png$/,
    );
    expect(() => creatorPortraitKey('../x', 'cr-1', 'png')).toThrow();
  });
});

describe('generateCreatorPortrait', () => {
  it('routes like an IMAGE_STILL shot and keeps a copy under the creator (not the 30-day output)', async () => {
    const { d, storage, objects } = deps();
    await storage.put({
      bucket: 'assets',
      key: 'orgs/org-1/no-project/out.png',
      body: fakePng(9, 9),
      contentType: 'image/png',
    });
    runProvider.mockResolvedValue(
      run({ s3Bucket: 'assets', s3Key: 'orgs/org-1/no-project/out.png', model: 'gpt-image-2' }),
    );
    const out = await generateCreatorPortrait(d, input);
    expect(runProvider.mock.calls[0]?.[0]).toEqual({
      need: { kind: 'shot', visualTreatment: 'IMAGE_STILL', durationSec: 5 },
      planTier: 'STANDARD',
      request: {
        capability: 'text_to_image',
        organisationId: 'org-1',
        prompt: creatorPortraitPrompt(input),
        aspectRatio: '9:16',
      },
    });
    expect(out).toMatchObject({
      s3Bucket: 'assets',
      contentType: 'image/png',
      providerId: 'openai:gpt-image-2',
      providerJobId: 'job-1',
      costPence: 5,
    });
    expect(out.s3Key).toMatch(/^orgs\/org-1\/creators\/cr-1\//);
    expect([...objects.keys()].some((k) => k.includes('/creators/cr-1/'))).toBe(true);
  });

  it('refuses a result that is not PNG or JPEG (Veo takes PNG/JPEG only)', async () => {
    const { d, storage } = deps();
    await storage.put({
      bucket: 'assets',
      key: 'o.webp',
      body: new TextEncoder().encode('RIFFxxxxWEBP'),
      contentType: 'image/webp',
    });
    runProvider.mockResolvedValue(run({ s3Bucket: 'assets', s3Key: 'o.webp' }));
    await expect(generateCreatorPortrait(d, input)).rejects.toMatchObject({
      errorClass: 'unsupported_image_type',
    });
  });
});
