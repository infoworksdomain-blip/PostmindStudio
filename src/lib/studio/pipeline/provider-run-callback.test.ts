import { describe, expect, it, vi } from 'vitest';
import { createCircuitBreaker } from '../providers/circuit-breaker';
import type { ProviderJobRecord, ProviderJobRepository } from '../providers/job-repository';
import { createMemoryProviderWake, type ProviderWake } from '../providers/provider-wake';
import { createProviderRegistry } from '../providers/registry';
import { StubAdapter } from '../providers/test-adapter';
import { pollIntervalMs, runProvider, type ProviderRunDeps } from './provider-run';

// BACKLOG 23.1 — a provider that calls back (Shotstack render callbacks) is woken by the callback
// instead of waiting for its next poll; polling stays as the fallback (20 s) and still completes
// the job when the callback is lost. Without wake flags (no Redis) the cadence is unchanged (5 s).

const T0 = Date.parse('2026-10-06T12:00:00Z');
const RENDER_DONE_AT = T0 + 3_000;
const CALLBACK_FALLBACK_MS = 20_000;

class CallbackAdapter extends StubAdapter {
  readonly callbackPollIntervalMs = CALLBACK_FALLBACK_MS;
}

function memoryRepo(): ProviderJobRepository {
  const rows = new Map<string, ProviderJobRecord>();
  return {
    async create(job) {
      const row: ProviderJobRecord = {
        id: `job-${rows.size + 1}`,
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
    async markFailed(id) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, state: 'FAILED' });
    },
    async recordUsage() {},
  };
}

/** A render that finishes at RENDER_DONE_AT; `onTick` runs whenever the fake clock moves. */
function setup(options: { wake?: ProviderWake; onTick?: (now: number) => Promise<void> }) {
  const adapter = new CallbackAdapter('shotstack', ['composition']);
  let now = T0;
  const polls: number[] = [];
  adapter.nextPoll = async () => {
    polls.push(now);
    return now >= RENDER_DONE_AT
      ? { state: 'succeeded', output: { url: 'https://stub.invalid/render.mp4', metadata: {} } }
      : { state: 'running' };
  };
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
    tracking: { repo: memoryRepo(), killSwitch, breaker, now: () => now },
    config: { providerTimeoutMs: 15 * 60_000, providerPollIntervalMs: 5_000 },
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      await options.onTick?.(now);
    },
    ...(options.wake && { providerWake: options.wake }),
  } as unknown as ProviderRunDeps;
  return { adapter, deps, polls, elapsed: () => now - T0 };
}

const composition = {
  need: { kind: 'capability' as const, capability: 'composition' as const },
  planTier: 'STANDARD' as const,
  request: {
    capability: 'composition' as const,
    organisationId: 'org-1',
    projectId: 'proj-1',
    edit: { timeline: { tracks: [] } },
    outputDurationSec: 8,
  },
};

describe('runProvider with render callbacks (23.1)', () => {
  it('a callback wakes the waiting job: it polls within a second instead of after 20 s', async () => {
    const wake = createMemoryProviderWake();
    let called = false;
    const run = setup({
      wake,
      // The callback route signals once Shotstack confirms the render is done.
      onTick: async (now) => {
        if (!called && now >= RENDER_DONE_AT) {
          called = true;
          await wake.signal('shotstack', 'stub_shotstack_1');
        }
      },
    });
    const result = await runProvider(composition, run.deps);
    expect(result.output.url).toBe('https://stub.invalid/render.mp4');
    expect(run.polls).toHaveLength(2);
    expect(run.elapsed()).toBeLessThanOrEqual(RENDER_DONE_AT - T0 + 1_000);
    expect(wake.pending()).toEqual([]); // the flag is consumed
  });

  it('a lost callback still completes by polling at the 20 s fallback', async () => {
    const run = setup({ wake: createMemoryProviderWake() });
    const result = await runProvider(composition, run.deps);
    expect(result.output.url).toBe('https://stub.invalid/render.mp4');
    expect(run.polls.map((t) => t - T0)).toEqual([0, CALLBACK_FALLBACK_MS]);
  });

  it('without wake flags (no Redis) the provider is polled every 5 s as before', async () => {
    const run = setup({});
    await runProvider(composition, run.deps);
    expect(run.polls.map((t) => t - T0)).toEqual([0, 5_000]);
    expect(pollIntervalMs(run.adapter, run.deps)).toBe(5_000);
  });

  it('providers that do not call back keep the 5 s cadence even with wake flags', () => {
    const plain = new StubAdapter('luma', ['text_to_video']);
    const { deps } = setup({ wake: createMemoryProviderWake() });
    expect(pollIntervalMs(plain, deps)).toBe(5_000);
  });
});
