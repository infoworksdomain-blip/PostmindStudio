import { describe, expect, it, vi } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { ProviderError } from '../../errors';
import { createCircuitBreaker } from '../providers/circuit-breaker';
import type { ProviderAdapter } from '../providers/interface';
import type { ProviderJobRecord, ProviderJobRepository } from '../providers/job-repository';
import { LumaAdapter } from '../providers/luma';
import { createProviderRegistry } from '../providers/registry';
import { StubAdapter } from '../providers/test-adapter';
import { runProvider, type ProviderRunDeps } from './provider-run';

// runProvider's timeout path with providers that cannot cancel (BACKLOG 13.32): the timeout
// still surfaces as a retryable ProviderError and the job keeps its reservation.

const T0 = Date.parse('2026-09-27T12:00:00Z');
const GEN_ID = 'd290f1ee-6c54-4b01-90e6-d701748f0851';

function memoryRepo() {
  const rows = new Map<string, ProviderJobRecord>();
  let seq = 0;
  const repo: ProviderJobRepository = {
    async create(job) {
      seq += 1;
      const row: ProviderJobRecord = {
        id: `job-${seq}`,
        organisationId: job.organisationId,
        projectId: job.projectId ?? null,
        provider: job.provider,
        providerJobId: null,
        state: 'PENDING',
        startedAt: new Date(T0),
        costPence: 0,
      };
      rows.set(row.id, row);
      return row;
    },
    async find(id) {
      return rows.get(id) ?? null;
    },
    async markRunning(id, providerJobId, costPence) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, state: 'RUNNING', providerJobId, costPence });
    },
    async markSucceeded(id, outcome) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, state: 'SUCCEEDED', costPence: outcome.costPence });
    },
    async markFailed(id, outcome) {
      const row = rows.get(id);
      if (row)
        rows.set(id, {
          ...row,
          state: outcome.state ?? 'FAILED',
          costPence: outcome.costPence ?? 0,
        });
    },
    async recordUsage() {},
  };
  return { repo, rows };
}

function setup(adapter: ProviderAdapter) {
  const { repo, rows } = memoryRepo();
  let now = T0;
  const breaker = createCircuitBreaker(() => now);
  const killSwitch = {
    check: vi.fn(async () => ({ killed: false as const })),
    assertNotKilled: vi.fn(async () => undefined),
  };
  const deps = {
    registry: createProviderRegistry([adapter]),
    breaker,
    killSwitch,
    budget: { hasBudget: async () => true },
    tracking: { repo, killSwitch, breaker, now: () => now },
    config: { providerTimeoutMs: 60_000, providerPollIntervalMs: 30_000 },
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  } as unknown as ProviderRunDeps;
  return { deps, rows, breaker };
}

const clip = {
  need: { kind: 'shot' as const, visualTreatment: 'AI_CLIP' as const, durationSec: 5 },
  planTier: 'STANDARD' as const,
  request: {
    capability: 'text_to_video' as const,
    organisationId: 'org-1',
    prompt: 'bread',
    durationSec: 5,
    aspectRatio: '9:16' as const,
  },
};

describe('runProvider timeout', () => {
  it('times out a Luma job without pretending to cancel it', async () => {
    const processing = () =>
      json({ id: GEN_ID, state: 'processing', output: [], failure_code: null });
    const fake = fakeFetch(
      json({ id: GEN_ID, state: 'queued', output: [] }, 201),
      processing,
      processing,
      processing,
    );
    const luma = new LumaAdapter({ apiKey: 'k', usdToGbpRate: 0.75, fetchImpl: fake.fetch });
    const { deps, rows, breaker } = setup(luma);

    const err = await runProvider(clip, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ errorClass: 'timeout', retryable: true });
    // Luma may still bill the clip, so the job keeps its 23p reservation and stays RUNNING.
    expect([...rows.values()]).toEqual([
      expect.objectContaining({ provider: 'luma', state: 'RUNNING', costPence: 23 }),
    ]);
    expect(fake.requests.some((r) => r.method === 'DELETE')).toBe(false);
    expect(await breaker.state('luma')).toBe('closed'); // one failure, below the threshold
  });

  it('still cancels providers that support it', async () => {
    const stub = new StubAdapter('luma', ['text_to_video'], { costPence: 23 });
    stub.nextPoll = async () => ({ state: 'running' });
    const { deps, rows } = setup(stub);
    await expect(runProvider(clip, deps)).rejects.toMatchObject({ errorClass: 'timeout' });
    expect([...rows.values()][0]).toMatchObject({ state: 'CANCELLED', costPence: 0 });
  });
});
