import { describe, expect, it, vi } from 'vitest';
import {
  KillSwitchTriggeredError,
  NotFoundError,
  ProviderError,
  ValidationError,
} from '../../errors';
import { createCircuitBreaker } from './circuit-breaker';
import type { ProviderJobRecord, ProviderJobRepository } from './job-repository';
import { StubAdapter } from './test-adapter';
import { cancelTracked, pollTracked, submitTracked } from './tracked';

const T0 = Date.parse('2026-09-27T12:00:00Z');

function memoryRepo() {
  const rows = new Map<string, ProviderJobRecord & Record<string, unknown>>();
  const usage: Array<Parameters<ProviderJobRepository['recordUsage']>[0]> = [];
  let seq = 0;
  const repo: ProviderJobRepository = {
    async create(job) {
      seq += 1;
      const row = {
        id: `job-${seq}`,
        organisationId: job.organisationId,
        projectId: job.projectId ?? null,
        provider: job.provider,
        providerJobId: null,
        state: 'PENDING',
        startedAt: new Date(T0),
        costPence: 0,
        operation: job.operation,
      };
      rows.set(row.id, row);
      return row;
    },
    async find(id) {
      return rows.get(id) ?? null;
    },
    async markRunning(id, providerJobId, costPence) {
      Object.assign(rows.get(id)!, { state: 'RUNNING', providerJobId, costPence });
    },
    async markSucceeded(id, outcome) {
      Object.assign(rows.get(id)!, { state: 'SUCCEEDED', ...outcome });
    },
    async markFailed(id, outcome) {
      Object.assign(rows.get(id)!, { ...outcome, state: outcome.state ?? 'FAILED' });
    },
    async recordUsage(u) {
      usage.push(u);
    },
  };
  return { repo, rows, usage };
}

function setup(killed = false) {
  const { repo, rows, usage } = memoryRepo();
  const breaker = createCircuitBreaker(() => T0);
  const killSwitch = {
    assertNotKilled: vi.fn(async () => {
      if (killed) throw new KillSwitchTriggeredError('global', 'stopped');
    }),
  };
  const adapter = new StubAdapter('runway', ['text_to_video'], { costPence: 45 });
  let now = T0;
  const d = { repo, killSwitch, breaker, now: () => now };
  return { adapter, d, rows, usage, breaker, killSwitch, advance: (ms: number) => (now += ms) };
}

const request = {
  capability: 'text_to_video' as const,
  organisationId: 'org-1',
  projectId: 'proj-1',
  prompt: 'bread',
  durationSec: 5,
  aspectRatio: '9:16' as const,
};

describe('submitTracked', () => {
  it('checks the kill switch with provider scope, then writes a RUNNING provider_jobs row', async () => {
    const { adapter, d, rows, killSwitch } = setup();
    const submitted = await submitTracked(adapter, request, d);
    expect(killSwitch.assertNotKilled).toHaveBeenCalledWith({
      organisationId: 'org-1',
      projectId: 'proj-1',
      providerId: 'runway',
    });
    expect(rows.get(submitted.jobId)).toMatchObject({
      state: 'RUNNING',
      provider: 'runway',
      operation: 'text_to_video',
      providerJobId: 'stub_runway_1',
      costPence: 45,
    });
  });

  it('does not call the provider or write a row when the kill switch is on', async () => {
    const { adapter, d, rows } = setup(true);
    await expect(submitTracked(adapter, request, d)).rejects.toBeInstanceOf(
      KillSwitchTriggeredError,
    );
    expect(adapter.submitCalls).toHaveLength(0);
    expect(rows.size).toBe(0);
  });

  it('records provider-side submit failures, usage and a breaker failure, then rethrows', async () => {
    const { adapter, d, rows, usage, breaker } = setup();
    adapter.nextSubmit = async () => {
      throw new ProviderError('runway', 'provider_unavailable', 'down', true);
    };
    for (let i = 0; i < 5; i += 1) {
      await expect(submitTracked(adapter, request, d)).rejects.toBeInstanceOf(ProviderError);
    }
    expect(
      [...rows.values()].every(
        (r) => r.state === 'FAILED' && r.errorClass === 'provider_unavailable',
      ),
    ).toBe(true);
    expect(usage.every((u) => !u.succeeded && u.costPence === 0)).toBe(true);
    expect(breaker.state('runway')).toBe('open');
  });

  it('does not count client-side errors against provider health', async () => {
    const { adapter, d, breaker } = setup();
    adapter.nextSubmit = async () => {
      throw new ProviderError('runway', 'invalid_request', 'bad ratio', false);
    };
    for (let i = 0; i < 6; i += 1) await submitTracked(adapter, request, d).catch(() => undefined);
    expect(breaker.state('runway')).toBe('closed');
  });

  it('marks timeouts TIMED_OUT and unknown throws as FAILED/unknown', async () => {
    const { adapter, d, rows } = setup();
    adapter.nextSubmit = async () => {
      throw new ProviderError('runway', 'timeout', 'slow', true);
    };
    await submitTracked(adapter, request, d).catch(() => undefined);
    adapter.nextSubmit = async () => {
      throw new TypeError('boom');
    };
    await submitTracked(adapter, request, d).catch(() => undefined);
    expect([...rows.values()].map((r) => [r.state, r.errorClass])).toEqual([
      ['TIMED_OUT', 'timeout'],
      ['FAILED', 'unknown'],
    ]);
  });
});

describe('pollTracked', () => {
  it('leaves running jobs untouched', async () => {
    const { adapter, d, rows } = setup();
    const { jobId } = await submitTracked(adapter, request, d);
    adapter.nextPoll = async () => ({ state: 'running' });
    await expect(pollTracked(adapter, jobId, d)).resolves.toEqual({ state: 'running' });
    expect(rows.get(jobId)?.state).toBe('RUNNING');
  });

  it('completes the job with actual cost, rolls up usage and closes the breaker', async () => {
    const { adapter, d, rows, usage, breaker, advance } = setup();
    const { jobId } = await submitTracked(adapter, request, d);
    advance(90_000);
    adapter.nextPoll = async () => ({
      state: 'succeeded',
      output: { url: 'https://out', metadata: { costPence: 40 } },
    });
    breaker.recordFailure('runway');
    await pollTracked(adapter, jobId, d);
    expect(rows.get(jobId)).toMatchObject({
      state: 'SUCCEEDED',
      costPence: 40,
      durationMs: 90_000,
    });
    expect(usage.at(-1)).toMatchObject({
      organisationId: 'org-1',
      provider: 'runway',
      succeeded: true,
      costPence: 40,
      projectId: 'proj-1',
    });
    expect(breaker.snapshot().runway).toBe('closed');
  });

  it('keeps the submit estimate when the provider reports no actual cost', async () => {
    const { adapter, d, rows } = setup();
    const { jobId } = await submitTracked(adapter, request, d);
    adapter.nextPoll = async () => ({
      state: 'succeeded',
      output: { metadata: { costPence: -1 } },
    });
    await pollTracked(adapter, jobId, d);
    expect(rows.get(jobId)?.costPence).toBe(45);
  });

  it('records provider failures and feeds the breaker', async () => {
    const { adapter, d, rows, usage } = setup();
    const { jobId } = await submitTracked(adapter, request, d);
    adapter.nextPoll = async () => ({
      state: 'failed',
      error: { class: 'provider_unavailable', message: 'INTERNAL', retryable: true },
    });
    const result = await pollTracked(adapter, jobId, d);
    expect(result.state).toBe('failed');
    expect(rows.get(jobId)).toMatchObject({
      state: 'FAILED',
      errorClass: 'provider_unavailable',
      errorMessage: 'INTERNAL',
    });
    expect(usage.at(-1)).toMatchObject({ succeeded: false, costPence: 0 });
  });

  it('rejects unknown, foreign or non-running jobs', async () => {
    const { adapter, d } = setup();
    await expect(pollTracked(adapter, 'nope', d)).rejects.toBeInstanceOf(NotFoundError);
    const { jobId } = await submitTracked(adapter, request, d);
    const other = new StubAdapter('luma', ['text_to_video']);
    await expect(pollTracked(other, jobId, d)).rejects.toBeInstanceOf(ValidationError);
    await pollTracked(adapter, jobId, d);
    await expect(pollTracked(adapter, jobId, d)).rejects.toThrow(/SUCCEEDED, not RUNNING/);
  });
});

describe('cancelTracked', () => {
  it('cancels at the provider and marks the row CANCELLED', async () => {
    const { adapter, d, rows } = setup();
    const cancel = vi.spyOn(adapter, 'cancel');
    const { jobId, providerJobId } = await submitTracked(adapter, request, d);
    await cancelTracked(adapter, jobId, d);
    expect(cancel).toHaveBeenCalledWith(providerJobId);
    expect(rows.get(jobId)).toMatchObject({ state: 'CANCELLED', errorClass: 'cancelled' });
  });

  it('is a no-op for finished jobs and 404s unknown ones', async () => {
    const { adapter, d } = setup();
    const cancel = vi.spyOn(adapter, 'cancel');
    const { jobId } = await submitTracked(adapter, request, d);
    await pollTracked(adapter, jobId, d);
    await cancelTracked(adapter, jobId, d);
    expect(cancel).not.toHaveBeenCalled();
    await expect(cancelTracked(adapter, 'nope', d)).rejects.toBeInstanceOf(NotFoundError);
  });
});
