import { describe, expect, it } from 'vitest';
import { NotImplementedError, UpstreamServiceError } from '../../errors';
import {
  engagementSentimentClient,
  isSentimentPending,
  PendingEngagementSentimentClient,
  SENTIMENT_PENDING_MESSAGE,
} from './engagement-sentiment';

// BACKLOG 13.39: the sentiment client ships as a contract with an honest NotImplemented path.

describe('engagement sentiment client', () => {
  it('is pending until Engagement ships its classifier API', async () => {
    const client = engagementSentimentClient();
    expect(client).toBeInstanceOf(PendingEngagementSentimentClient);
    const call = client.publicationSentiment({
      organisationId: 'org',
      publications: [{ platform: 'tiktok', platformPostId: '7301' }],
    });
    await expect(call).rejects.toBeInstanceOf(NotImplementedError);
    await expect(call).rejects.toThrow(SENTIMENT_PENDING_MESSAGE);
  });

  it('tells callers to skip the signal only for the pending case', () => {
    expect(isSentimentPending(new NotImplementedError(SENTIMENT_PENDING_MESSAGE))).toBe(true);
    expect(isSentimentPending(new UpstreamServiceError('Engagement down'))).toBe(false);
  });
});
