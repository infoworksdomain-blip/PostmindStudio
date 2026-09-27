import { describe, expect, it } from 'vitest';
import { NotImplementedError } from '../../errors';
import { BUSINESS_LIST_PENDING_MESSAGE, pendingCoreBusinessDirectory } from './business-directory';
import { CHANNEL_LIST_PENDING_MESSAGE, pendingCoreChannelDirectory } from './channel-directory';

// BACKLOG 13.34 / 13.35: the Core directories are honest 501s until Core ships the endpoints.

describe('pending Core directories', () => {
  it('business list throws NotImplementedError naming the Core endpoint it waits for', async () => {
    const call = pendingCoreBusinessDirectory.listBusinesses('org');
    await expect(call).rejects.toBeInstanceOf(NotImplementedError);
    await expect(call).rejects.toThrow(BUSINESS_LIST_PENDING_MESSAGE);
    expect(BUSINESS_LIST_PENDING_MESSAGE).toContain('/api/internal/organisations/:id/businesses');
  });

  it('channel list is not ready and throws NotImplementedError if called anyway', async () => {
    expect(pendingCoreChannelDirectory.ready).toBe(false);
    const call = pendingCoreChannelDirectory.listChannels('org');
    await expect(call).rejects.toBeInstanceOf(NotImplementedError);
    await expect(call).rejects.toThrow(CHANNEL_LIST_PENDING_MESSAGE);
  });
});
