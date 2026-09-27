import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CostCapPausedError, ProviderError } from '../../errors';
import type { PipelineDeps } from './deps';
import { cueKey, groupCues, produceSfx } from './sfx';

const runProvider = vi.fn();
const mergeProjectMetadata = vi.fn(async () => true);
vi.mock('./provider-run', () => ({ runProvider: (...a: unknown[]) => runProvider(...a) }));
vi.mock('./project-state', () => ({
  mergeProjectMetadata: (...a: unknown[]) => mergeProjectMetadata(...(a as [])),
}));

const project = { id: 'prj_1', organisationId: 'org_1' };

function deps(over: { adapters?: number; existing?: unknown; minTier?: 'PLUS' } = {}) {
  const findFirst = vi.fn(async () => over.existing ?? null);
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: `ast_${String(data.fingerprint).slice(4, 10)}`,
    ...data,
  }));
  const d = {
    db: { videoAsset: { findFirst, create } },
    registry: {
      getAdaptersByCapability: vi.fn(() => Array.from({ length: over.adapters ?? 1 })),
    },
    config: { musicMinTier: over.minTier },
    logger: pino({ level: 'silent' }),
  } as unknown as PipelineDeps;
  return { d, findFirst, create };
}

const shots = [
  { id: 's1', sfxCue: 'Whoosh' },
  { id: 's2', sfxCue: null },
  { id: 's3', sfxCue: 'whoosh!' },
  { id: 's4', sfxCue: 'cash register' },
  { id: 's5', sfxCue: '!!!' },
];

const stored = (title: string) => ({
  decision: { providerId: 'storyblocks-audio' },
  providerJobRowId: 'pj_1',
  output: {
    metadata: {
      s3Bucket: 'assets',
      s3Key: `orgs/org_1/${title}.mp3`,
      bytes: 3,
      durationSec: 1.5,
      title,
      stockItemId: '42',
    },
  },
});

beforeEach(() => {
  runProvider.mockReset();
  mergeProjectMetadata.mockClear();
});

describe('groupCues', () => {
  it('groups shots by normalised cue and drops empty ones', () => {
    const groups = groupCues(shots);
    expect(groups.map((g) => [g.cue, g.shotIds])).toEqual([
      ['Whoosh', ['s1', 's3']],
      ['cash register', ['s4']],
    ]);
    expect(groups[0]?.key).toBe(cueKey('whoosh'));
  });
});

describe('produceSfx', () => {
  it('records none when the script has no cues', async () => {
    const { d } = deps();
    const clips = await produceSfx(d, { project, runId: 'r1', planTier: 'STANDARD', shots: [] });
    expect(clips.size).toBe(0);
    expect(mergeProjectMetadata).toHaveBeenCalledWith(d.db, {
      projectId: 'prj_1',
      runId: 'r1',
      patch: { sfx: { status: 'none', runId: 'r1', cues: [] } },
    });
  });

  it('is off below the Layer 5 tier and unavailable without a provider', async () => {
    const low = deps({ minTier: 'PLUS' });
    await produceSfx(low.d, { project, runId: 'r1', planTier: 'STANDARD', shots });
    expect(mergeProjectMetadata).toHaveBeenLastCalledWith(low.d.db, {
      projectId: 'prj_1',
      runId: 'r1',
      patch: { sfx: { status: 'off_for_plan', runId: 'r1', cues: [] } },
    });
    const none = deps({ adapters: 0 });
    await produceSfx(none.d, { project, runId: 'r1', planTier: 'STANDARD', shots });
    expect(mergeProjectMetadata).toHaveBeenLastCalledWith(
      none.d.db,
      expect.objectContaining({
        patch: { sfx: expect.objectContaining({ status: 'unavailable' }) },
      }),
    );
    expect(runProvider).not.toHaveBeenCalled();
  });

  it('fetches each distinct cue once, stores AUDIO_SFX assets and maps them to shots', async () => {
    const { d, create } = deps();
    runProvider.mockResolvedValueOnce(stored('whoosh')).mockResolvedValueOnce(stored('till'));
    const clips = await produceSfx(d, { project, runId: 'r1', planTier: 'STANDARD', shots });
    expect(runProvider).toHaveBeenCalledTimes(2);
    expect(runProvider.mock.calls[0]?.[0]).toMatchObject({
      need: { kind: 'capability', capability: 'sfx' },
      request: { capability: 'sfx', query: 'Whoosh', maxDurationSec: 3 },
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'AUDIO_SFX',
        source: 'storyblocks-audio:42',
        fingerprint: cueKey('Whoosh'),
        costPence: 0,
      }),
    });
    expect([...clips.keys()]).toEqual(['s1', 's3', 's4']);
    expect(clips.get('s1')).toEqual({
      bucket: 'assets',
      key: 'orgs/org_1/whoosh.mp3',
      durationSec: 1.5,
    });
    const recorded = (mergeProjectMetadata.mock.calls.at(-1) as unknown[])[1] as {
      patch: { sfx: { status: string; cues: Array<{ status: string }> } };
    };
    expect(recorded.patch.sfx.status).toBe('added');
    expect(recorded.patch.sfx.cues.map((c) => c.status)).toEqual(['added', 'added']);
  });

  it('reuses a stored clip for the same cue', async () => {
    const { d } = deps({
      existing: {
        id: 'ast_old',
        s3Bucket: 'assets',
        s3Key: 'old.mp3',
        durationSec: 2,
        metadata: { title: 'Old whoosh' },
      },
    });
    const clips = await produceSfx(d, {
      project,
      runId: 'r1',
      planTier: 'STANDARD',
      shots: [{ id: 's1', sfxCue: 'whoosh' }],
    });
    expect(runProvider).not.toHaveBeenCalled();
    expect(clips.get('s1')?.key).toBe('old.mp3');
  });

  it('keeps going when a cue has no match or fails; propagates a paused budget', async () => {
    const { d } = deps();
    runProvider
      .mockRejectedValueOnce(
        new ProviderError('storyblocks-audio', 'invalid_request', 'no match', false),
      )
      .mockRejectedValueOnce(new Error('boom'));
    const clips = await produceSfx(d, { project, runId: 'r1', planTier: 'STANDARD', shots });
    expect(clips.size).toBe(0);
    const recorded = (mergeProjectMetadata.mock.calls.at(-1) as unknown[])[1] as {
      patch: { sfx: { status: string; cues: Array<{ status: string }> } };
    };
    expect(recorded.patch.sfx.status).toBe('failed');
    expect(recorded.patch.sfx.cues.map((c) => c.status)).toEqual(['no_match', 'failed']);

    runProvider.mockRejectedValueOnce(new CostCapPausedError('project', 'paused'));
    await expect(
      produceSfx(d, { project, runId: 'r1', planTier: 'STANDARD', shots }),
    ).rejects.toBeInstanceOf(CostCapPausedError);
  });

  it('treats a provider result without a stored file as a failed cue', async () => {
    const { d } = deps();
    runProvider.mockResolvedValue({
      decision: { providerId: 'storyblocks-audio' },
      providerJobRowId: 'pj',
      output: { metadata: {} },
    });
    const clips = await produceSfx(d, {
      project,
      runId: 'r1',
      planTier: 'STANDARD',
      shots: [{ id: 's1', sfxCue: 'gong' }],
    });
    expect(clips.size).toBe(0);
  });
});
