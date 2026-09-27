import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { UpstreamServiceError } from '../../../errors';
import type { CoreChannelDirectory } from '../../core/channel-directory';
import type { PipelineDeps } from '../../pipeline/deps';
import { reconcileChannels } from './reconcile-channels';

// BACKLOG 13.35: the daily reconcile-channels job.

const data = {
  organisationId: 'postmind-platform',
  runId: 'reconcile-channels',
  planTier: 'STANDARD' as const,
};

function deps(coreChannels?: CoreChannelDirectory) {
  const logger = pino({ level: 'silent' });
  const info = vi.spyOn(logger, 'info');
  const platformConnection = {
    findMany: vi.fn(async () => [
      {
        id: 'c1',
        organisationId: 'org-a',
        platform: 'instagram',
        platformAccountId: '1001',
        platformAccountName: '@bakery',
        state: 'active',
      },
    ]),
    updateMany: vi.fn(async () => ({ count: 1 })),
    findUniqueOrThrow: vi.fn(async () => ({})),
  };
  const d = {
    db: { platformConnection },
    logger,
    audit: vi.fn(),
    now: () => 0,
    ...(coreChannels && { coreChannels }),
  } as unknown as PipelineDeps;
  return { d, info, platformConnection };
}

describe('reconcile-channels job', () => {
  it('skips quietly while Core has no list-channels endpoint', async () => {
    const { d, info, platformConnection } = deps();
    await expect(reconcileChannels(data, d)).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith(
      { reason: expect.stringContaining('waiting for Core list-channels') },
      'channel reconciliation skipped',
    );
    expect(platformConnection.findMany).not.toHaveBeenCalled();
  });

  it('applies the reconciliation once Core is wired', async () => {
    const directory: CoreChannelDirectory = { ready: true, listChannels: vi.fn(async () => []) };
    const { d, platformConnection } = deps(directory);
    await reconcileChannels(data, d);
    // The organisation's only channel is not listed by Core → disconnected.
    expect(platformConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'c1', organisationId: 'org-a' }),
      }),
    );
  });

  it('lets unexpected errors fail the run', async () => {
    const { d, platformConnection } = deps({ ready: true, listChannels: async () => [] });
    platformConnection.findMany.mockRejectedValueOnce(new UpstreamServiceError('db down'));
    await expect(reconcileChannels(data, d)).rejects.toThrow('db down');
  });
});
