import { describe, expect, it, vi } from 'vitest';
import {
  KillSwitchTriggeredError,
  NotFoundError,
  ProviderError,
  ValidationError,
} from '../../errors';
import { ACCOUNT_HOLD_MS } from './account-errors';
import { createCircuitBreaker, OPEN_DURATION_MS } from './circuit-breaker';
import type { ProviderJobRecord, ProviderJobRepository, UsageDelta } from './job-repository';
import { StubAdapter } from './test-adapter';
import { cancelTracked, pollTracked, redactUrls, submitTracked } from './tracked';

const T0 = Date.parse('2026-09-27T12:00:00Z');
const scope = { organisationId: 'org-1' };

function memoryRepo() {
  const rows = new Map<string, ProviderJobRecord & Record<string, unknown>>();
  const usage: UsageDelta[] = [];
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
  /** Net effect of all deltas, as provider_usage / costActualPence would hold it. */
  const totals = () =>
    usage.reduce(
      (t, u) => ({
        jobs: t.jobs + u.jobs,
        succeeded: t.succeeded + u.succeeded,
        failed: t.failed + u.failed,
        costPence: t.costPence + u.costDeltaPence,
      }),
      { jobs: 0, succeeded: 0, failed: 0, costPence: 0 },
    );
  return { repo, rows, usage, totals };
}

function setup(killed = false) {
  const { repo, rows, usage, totals } = memoryRepo();
  let now = T0;
  const breaker = createCircuitBreaker(() => now);
  const killSwitch = {
    assertNotKilled: vi.fn(async () => {
      if (killed) throw new KillSwitchTriggeredError('global', 'stopped');
    }),
  };
  const adapter = new StubAdapter('runway', ['text_to_video'], { costPence: 45 });
  const d = { repo, killSwitch, breaker, now: () => now };
  return {
    adapter,
    d,
    rows,
    usage,
    totals,
    breaker,
    killSwitch,
    advance: (ms: number) => (now += ms),
  };
}

const request = {
  capability: 'text_to_video' as const,
  organisationId: 'org-1',
  projectId: 'proj-1',
  prompt: 'bread',
  durationSec: 5,
  aspectRatio: '9:16' as const,
};

function openBreaker(ctx: ReturnType<typeof setup>) {
  for (let i = 0; i < 5; i += 1) ctx.breaker.recordFailure('runway');
  ctx.advance(OPEN_DURATION_MS);
  expect(ctx.breaker.tryAcquire('runway')).toBe(true); // router claims the half-open trial
}

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

  it('reserves the estimated cost at submit so an unpolled job still counts against caps', async () => {
    const { adapter, d, usage } = setup();
    await submitTracked(adapter, request, d);
    expect(usage).toEqual([
      {
        organisationId: 'org-1',
        provider: 'runway',
        day: new Date(T0),
        jobs: 1,
        succeeded: 0,
        failed: 0,
        costDeltaPence: 45,
        projectId: 'proj-1',
      },
    ]);
  });

  it('does not call the provider or write a row when the kill switch is on', async () => {
    const { adapter, d, rows } = setup(true);
    await expect(submitTracked(adapter, request, d)).rejects.toBeInstanceOf(
      KillSwitchTriggeredError,
    );
    expect(adapter.submitCalls).toHaveLength(0);
    expect(rows.size).toBe(0);
  });

  it('releases a claimed half-open trial when the kill switch aborts the submit', async () => {
    const ctx = setup(true);
    openBreaker(ctx);
    await submitTracked(ctx.adapter, request, ctx.d).catch(() => undefined);
    expect(ctx.breaker.tryAcquire('runway')).toBe(true);
  });

  it('records provider-side submit failures with no cost, feeds the breaker, rethrows', async () => {
    const { adapter, d, rows, totals, breaker } = setup();
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
    expect(totals()).toEqual({ jobs: 5, succeeded: 0, failed: 5, costPence: 0 });
    expect(breaker.state('runway')).toBe('open');
  });

  it('20.11: holds the provider at once on an account error, until the stated resume time', async () => {
    const ctx = setup();
    const regain = new Date(T0 + 6 * 60 * 60_000).toISOString();
    ctx.adapter.nextSubmit = async () => {
      throw new ProviderError('runway', 'account_limit', 'usage limit reached', false, {
        retryAt: regain,
      });
    };
    await expect(submitTracked(ctx.adapter, request, ctx.d)).rejects.toBeInstanceOf(ProviderError);
    expect(ctx.breaker.state('runway')).toBe('open'); // one failure, not five
    expect(ctx.breaker.accountHolds().runway).toMatchObject({
      errorClass: 'account_limit',
      reason: 'usage limit reached',
      until: Date.parse(regain),
    });
    ctx.advance(OPEN_DURATION_MS * 2);
    expect(ctx.breaker.tryAcquire('runway')).toBe(false);
  });

  it('20.11: holds for the default 15 minutes when no resume time is stated', async () => {
    const ctx = setup();
    ctx.adapter.nextSubmit = async () => {
      throw new ProviderError('runway', 'insufficient_credits', 'no credits', false);
    };
    await submitTracked(ctx.adapter, request, ctx.d).catch(() => undefined);
    expect(ctx.breaker.accountHolds().runway?.until).toBe(T0 + ACCOUNT_HOLD_MS);
  });

  it('does not count client-side errors against provider health and frees a trial', async () => {
    const ctx = setup();
    ctx.adapter.nextSubmit = async () => {
      throw new ProviderError('runway', 'invalid_request', 'bad ratio', false);
    };
    for (let i = 0; i < 6; i += 1)
      await submitTracked(ctx.adapter, request, ctx.d).catch(() => undefined);
    expect(ctx.breaker.state('runway')).toBe('closed');

    openBreaker(ctx);
    await submitTracked(ctx.adapter, request, ctx.d).catch(() => undefined);
    expect(ctx.breaker.tryAcquire('runway')).toBe(true);
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
    await expect(pollTracked(adapter, jobId, scope, d)).resolves.toEqual({ state: 'running' });
    expect(rows.get(jobId)?.state).toBe('RUNNING');
  });

  it('settles the reservation to the actual cost and closes the breaker', async () => {
    const { adapter, d, rows, totals, breaker, advance } = setup();
    const { jobId } = await submitTracked(adapter, request, d);
    advance(90_000);
    adapter.nextPoll = async () => ({
      state: 'succeeded',
      output: {
        url: 'https://signed.example/x?X-Amz-Signature=abc',
        metadata: { costPence: 40, s3Key: 'k' },
      },
    });
    breaker.recordFailure('runway');
    const result = await pollTracked(adapter, jobId, scope, d);
    expect(result.output?.url).toContain('X-Amz-Signature'); // caller still gets the URL
    expect(rows.get(jobId)).toMatchObject({
      state: 'SUCCEEDED',
      costPence: 40,
      durationMs: 90_000,
      responseBody: { url: '[redacted: temporary URL]', metadata: { costPence: 40, s3Key: 'k' } },
    });
    expect(totals()).toEqual({ jobs: 1, succeeded: 1, failed: 0, costPence: 40 });
    expect(breaker.snapshot().runway).toBe('closed');
  });

  it('keeps the reserved estimate when the provider reports no actual cost', async () => {
    const { adapter, d, rows, totals } = setup();
    const { jobId } = await submitTracked(adapter, request, d);
    adapter.nextPoll = async () => ({
      state: 'succeeded',
      output: { metadata: { costPence: -1 } },
    });
    await pollTracked(adapter, jobId, scope, d);
    expect(rows.get(jobId)?.costPence).toBe(45);
    expect(totals().costPence).toBe(45);
  });

  it('releases the reservation on failure and feeds the breaker', async () => {
    const { adapter, d, rows, totals } = setup();
    const { jobId } = await submitTracked(adapter, request, d);
    adapter.nextPoll = async () => ({
      state: 'failed',
      error: { class: 'provider_unavailable', message: 'INTERNAL', retryable: true },
    });
    const result = await pollTracked(adapter, jobId, scope, d);
    expect(result.state).toBe('failed');
    expect(rows.get(jobId)).toMatchObject({
      state: 'FAILED',
      errorClass: 'provider_unavailable',
      errorMessage: 'INTERNAL',
      costPence: 0,
    });
    expect(totals()).toEqual({ jobs: 1, succeeded: 0, failed: 1, costPence: 0 });
  });

  it('keeps what the provider billed for a failed job', async () => {
    const { adapter, d, rows, totals } = setup();
    const { jobId } = await submitTracked(adapter, request, d);
    adapter.nextPoll = async () => ({
      state: 'failed',
      error: { class: 'content_policy', message: 'SAFETY.INPUT.TEXT', retryable: false },
      output: { metadata: { costPence: 45 } },
    });
    await pollTracked(adapter, jobId, scope, d);
    expect(rows.get(jobId)?.costPence).toBe(45);
    expect(totals().costPence).toBe(45);
  });

  it('hides other organisations’ jobs and rejects foreign or non-running jobs', async () => {
    const { adapter, d } = setup();
    await expect(pollTracked(adapter, 'nope', scope, d)).rejects.toBeInstanceOf(NotFoundError);
    const { jobId } = await submitTracked(adapter, request, d);
    await expect(
      pollTracked(adapter, jobId, { organisationId: 'org-2' }, d),
    ).rejects.toBeInstanceOf(NotFoundError);
    const other = new StubAdapter('luma', ['text_to_video']);
    await expect(pollTracked(other, jobId, scope, d)).rejects.toBeInstanceOf(ValidationError);
    await pollTracked(adapter, jobId, scope, d);
    await expect(pollTracked(adapter, jobId, scope, d)).rejects.toThrow(/SUCCEEDED, not RUNNING/);
  });
});

describe('cancelTracked', () => {
  it('cancels at the provider, marks CANCELLED and releases the reservation', async () => {
    const { adapter, d, rows, totals } = setup();
    const cancel = vi.spyOn(adapter, 'cancel');
    const { jobId, providerJobId } = await submitTracked(adapter, request, d);
    await cancelTracked(adapter, jobId, scope, d);
    expect(cancel).toHaveBeenCalledWith(providerJobId);
    expect(rows.get(jobId)).toMatchObject({ state: 'CANCELLED', errorClass: 'cancelled' });
    expect(totals()).toEqual({ jobs: 1, succeeded: 0, failed: 1, costPence: 0 });
  });

  it('is a no-op for finished jobs and 404s unknown or foreign ones', async () => {
    const { adapter, d } = setup();
    const cancel = vi.spyOn(adapter, 'cancel');
    const { jobId } = await submitTracked(adapter, request, d);
    await expect(
      cancelTracked(adapter, jobId, { organisationId: 'org-2' }, d),
    ).rejects.toBeInstanceOf(NotFoundError);
    await pollTracked(adapter, jobId, scope, d);
    await cancelTracked(adapter, jobId, scope, d);
    expect(cancel).not.toHaveBeenCalled();
    await expect(cancelTracked(adapter, 'nope', scope, d)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('redactUrls', () => {
  it('replaces every http(s) string, recursively', () => {
    expect(
      redactUrls({
        url: 'https://a/b?sig=1',
        nested: [{ poster: 'http://p' }, 'text', 3],
        s3Key: 'orgs/o/x',
      }),
    ).toEqual({
      url: '[redacted: temporary URL]',
      nested: [{ poster: '[redacted: temporary URL]' }, 'text', 3],
      s3Key: 'orgs/o/x',
    });
  });
});
