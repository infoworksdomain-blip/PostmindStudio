import type { VideoProject } from '@prisma/client';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineDeps } from '../../pipeline/deps';
import type { IdeationResult } from '../../pipeline/ideation';
import type { CopyContext } from '../../services/caption-suggestions';
import type { ProjectJobData } from '../queues';
import { startPostCopy } from './plan-project';

// 23.2 — the post copy is a light call started from the brief while Layer 2 runs; it never fails
// the plan.

const { runProvider } = vi.hoisted(() => ({ runProvider: vi.fn() }));
vi.mock('../../pipeline/provider-run', async (original) => ({
  ...(await original<typeof import('../../pipeline/provider-run')>()),
  runProvider,
}));

const data = {
  projectId: 'p1',
  organisationId: 'o1',
  runId: 'r1',
  planTier: 'STANDARD',
} as ProjectJobData;
const project = {
  id: 'p1',
  language: 'en-GB',
  targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 }],
} as unknown as VideoProject;
const brief = {
  actionable: true,
  directionOptions: [],
  hook: 'Still buying supermarket bread?',
  keyMessage: 'Real sourdough, baked at dawn',
  targetAudience: 'Leeds commuters',
  tone: 'warm',
  callToAction: 'Order today',
  keywords: ['sourdough'],
  restrictedTopicsMentioned: [],
} as IdeationResult;
const copy: CopyContext = {
  policy: { business: 'AheadAI', always: [] },
  facts: { businessName: 'AheadAI Bakery' },
  profile: null,
  restrictedTopics: [],
  moments: [],
};
const log = { warn: vi.fn() } as unknown as Logger;
const deps = {} as PipelineDeps;

beforeEach(() => runProvider.mockReset());

describe('startPostCopy', () => {
  it('asks the light post_copy task for the platforms from the brief', async () => {
    runProvider.mockResolvedValue({
      decision: { providerId: 'anthropic' },
      output: {
        metadata: {
          json: {
            suggestions: [
              { platform: 'tiktok', caption: 'Still buying?', hashtags: ['sourdough'], title: '' },
            ],
          },
        },
      },
    });
    const posts = await startPostCopy(deps, data, project, brief, copy, log);
    expect(posts).toEqual([
      { platform: 'tiktok', caption: 'Still buying?', hashtags: ['sourdough'], title: '' },
    ]);
    const input = runProvider.mock.calls[0]?.[0] as {
      request: { task: string; prompt: string; system: string };
    };
    expect(input.request.task).toBe('post_copy');
    expect(input.request.prompt).toContain('Hook: Still buying supermarket bread?');
    expect(input.request.prompt).toContain('do not repeat them: #AheadAI');
  });

  it('starts at once (the caller awaits it only after Layer 2)', () => {
    let finish!: (v: unknown) => void;
    runProvider.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const pending = startPostCopy(deps, data, project, brief, copy, log);
    expect(runProvider).toHaveBeenCalledTimes(1);
    finish({
      decision: { providerId: 'anthropic' },
      output: { metadata: { json: { suggestions: [] } } },
    });
    return expect(pending).resolves.toEqual([]);
  });

  it('never rejects: a failed or invalid answer is null (Publish falls back to the hook)', async () => {
    runProvider.mockRejectedValueOnce(new Error('Claude down'));
    await expect(startPostCopy(deps, data, project, brief, copy, log)).resolves.toBeNull();
    runProvider.mockResolvedValueOnce({
      decision: { providerId: 'anthropic' },
      output: { metadata: { json: { nope: true } } },
    });
    await expect(startPostCopy(deps, data, project, brief, copy, log)).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it('makes no call without the copy context or platforms', async () => {
    await expect(startPostCopy(deps, data, project, brief, null, log)).resolves.toBeNull();
    await expect(
      startPostCopy(deps, data, { ...project, targetFormats: [] }, brief, copy, log),
    ).resolves.toBeNull();
    expect(runProvider).not.toHaveBeenCalled();
  });
});
