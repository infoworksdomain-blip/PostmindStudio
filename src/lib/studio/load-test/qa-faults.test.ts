import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError, ProviderError } from '../../errors';
import type { ProviderAdapter, ProviderRequest } from '../providers/interface';
import { isAccountErrorClass } from '../providers/account-errors';
import { dummyKeyPlatformFetch, withFault } from './qa-faults';

// 20.31: the fault injectors of the stubbed full-pipeline run.

const request = {
  capability: 'text_to_video',
  organisationId: 'o1',
  prompt: 'bread',
  durationSec: 4,
  aspectRatio: '9:16',
} as ProviderRequest;

function inner(): ProviderAdapter & { estimateCostPence(): number } {
  return {
    providerId: 'seedance',
    capabilities: ['text_to_video'],
    submit: vi.fn(async () => ({
      providerJobId: 'sim_1',
      estimatedCostPence: 19,
      estimatedReadyAt: new Date(),
    })),
    poll: vi.fn(async () => ({ state: 'running' as const })),
    cancel: vi.fn(async () => undefined),
    healthCheck: vi.fn(async () => ({ healthy: true })),
    estimateCostPence: () => 19,
  };
}

describe('withFault', () => {
  it('a 429 is retryable and not an account problem (the job is retried)', async () => {
    const { adapter, counters } = withFault(inner(), 'rate_limited');
    const err = await adapter.submit(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({
      providerId: 'seedance',
      errorClass: 'rate_limited',
      retryable: true,
    });
    expect(isAccountErrorClass((err as ProviderError).errorClass)).toBe(false);
    expect(counters.refused).toBe(1);
  });

  it('out of credit is an account problem and is not retried on the same provider', async () => {
    const { adapter } = withFault(inner(), 'insufficient_credits');
    const err = (await adapter.submit(request).catch((e: unknown) => e)) as ProviderError;
    expect(isAccountErrorClass(err.errorClass)).toBe(true);
    expect(err.retryable).toBe(false);
  });

  it('keeps the wrapped provider id, capabilities and cost estimate', async () => {
    const real = inner();
    const { adapter } = withFault(real, 'rate_limited');
    expect(adapter.providerId).toBe('seedance');
    expect(adapter.capabilities).toEqual(['text_to_video']);
    expect((adapter as unknown as { estimateCostPence(): number }).estimateCostPence()).toBe(19);
    await adapter.healthCheck();
    expect(real.healthCheck).toHaveBeenCalledOnce();
    expect(real.submit).not.toHaveBeenCalled();
  });
});

describe('dummyKeyPlatformFetch', () => {
  it('answers a social platform with the 401 a dummy key gets, without a network call', async () => {
    const inner = vi.fn(async () => new Response('real'));
    const calls: string[] = [];
    const f = dummyKeyPlatformFetch(inner as unknown as typeof fetch, (h) => calls.push(h));
    const res = await f('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'access_token_invalid' } });
    expect(calls).toEqual(['open.tiktokapis.com']);
    expect(inner).not.toHaveBeenCalled();
  });

  it('lets local URLs through and refuses everything else', async () => {
    const inner = vi.fn(async () => new Response('ok'));
    const f = dummyKeyPlatformFetch(inner as unknown as typeof fetch);
    await f('http://127.0.0.1:9/x');
    expect(inner).toHaveBeenCalledOnce();
    await expect(f('https://api.byteplus.com/v3/tasks')).rejects.toThrow(ConfigurationError);
  });
});
