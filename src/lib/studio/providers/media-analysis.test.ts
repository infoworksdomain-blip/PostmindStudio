import { describe, expect, it } from 'vitest';
import { NotImplementedError, NoProviderAvailableError } from '../../errors';
import { createCircuitBreaker } from './circuit-breaker';
import type { MediaAnalysisRequest } from './interface';
import {
  MEDIA_ANALYSIS_PROVIDER_ID,
  MediaAnalysisAdapter,
  NO_INFERENCE_HOST,
} from './media-analysis';
import { createProviderRegistry } from './registry';
import { routeProvider } from './router';

// BACKLOG 13.36: the media-analysis contract ships without a host and is never selected.

const request: MediaAnalysisRequest = {
  capability: 'media_analysis',
  organisationId: 'org',
  mediaUrl: 'https://assets.test/video.mp4',
  analyses: ['bpm_key', 'clip_visual', 'clap_audio'],
  durationSec: 30,
};

describe('MediaAnalysisAdapter', () => {
  const adapter = new MediaAnalysisAdapter();

  it('declares the media_analysis capability', () => {
    expect(adapter.providerId).toBe(MEDIA_ANALYSIS_PROVIDER_ID);
    expect(adapter.capabilities).toEqual(['media_analysis']);
  });

  it('reports unhealthy: no inference host configured', async () => {
    await expect(adapter.healthCheck()).resolves.toEqual({
      healthy: false,
      reason: NO_INFERENCE_HOST,
    });
  });

  it('throws NotImplementedError from submit, poll and cancel', async () => {
    await expect(adapter.submit(request)).rejects.toBeInstanceOf(NotImplementedError);
    await expect(adapter.poll('job')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(adapter.cancel('job')).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('is never selected by the router, even when registered', async () => {
    const registry = createProviderRegistry([adapter]);
    await expect(
      routeProvider(
        {
          need: { kind: 'capability', capability: 'media_analysis' },
          planTier: 'ENTERPRISE',
          organisationId: 'org',
          request,
        },
        {
          registry,
          breaker: createCircuitBreaker(() => 0),
          killSwitch: { check: async () => ({ killed: false }) },
          budget: { hasBudget: async () => true },
        },
      ),
    ).rejects.toBeInstanceOf(NoProviderAvailableError);
  });
});
