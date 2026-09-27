import { describe, expect, it, vi } from 'vitest';
import { CHECK_TIMEOUT_MS, runReadiness } from './readiness';
import type { ReadinessCheck } from './readiness';

function check(name: string, run: () => Promise<unknown>): ReadinessCheck {
  return { name, run };
}

describe('runReadiness', () => {
  it('reports ok:true when every check succeeds', async () => {
    const report = await runReadiness([
      check('db', async () => undefined),
      check('redis', async () => undefined),
    ]);

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual({
      db: { status: 'up', latencyMs: expect.any(Number) as unknown as number },
      redis: { status: 'up', latencyMs: expect.any(Number) as unknown as number },
    });
  });

  it('reports ok:false and status down for a check that rejects', async () => {
    const report = await runReadiness([
      check('db', async () => undefined),
      check('redis', async () => {
        throw new Error('connection refused');
      }),
    ]);

    expect(report.ok).toBe(false);
    expect(report.checks.db?.status).toBe('up');
    expect(report.checks.redis?.status).toBe('down');
  });

  it('treats a check that never resolves as down once the timeout elapses', async () => {
    const report = await runReadiness([check('stuck', () => new Promise(() => undefined))], {
      timeoutMs: 10,
    });

    expect(report.ok).toBe(false);
    expect(report.checks.stuck?.status).toBe('down');
  });

  it('uses the default timeout when none is supplied', () => {
    expect(CHECK_TIMEOUT_MS).toBe(2_000);
  });

  it('calls onFailure with the check name and error for a failing check', async () => {
    const onFailure = vi.fn();
    const boom = new Error('boom');

    await runReadiness(
      [
        check('db', async () => {
          throw boom;
        }),
      ],
      { onFailure },
    );

    expect(onFailure).toHaveBeenCalledWith('db', boom);
  });

  it('does not call onFailure for successful checks', async () => {
    const onFailure = vi.fn();

    await runReadiness([check('db', async () => undefined)], { onFailure });

    expect(onFailure).not.toHaveBeenCalled();
  });

  it('calls onFailure for a timed-out check with a timeout error', async () => {
    const onFailure = vi.fn();

    await runReadiness([check('stuck', () => new Promise(() => undefined))], {
      timeoutMs: 5,
      onFailure,
    });

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]?.[0]).toBe('stuck');
    expect((onFailure.mock.calls[0]?.[1] as Error).message).toBe('timeout');
  });

  it('measures latency using the injected now() function', async () => {
    let calls = 0;
    const now = () => {
      calls += 1;
      return calls === 1 ? 1_000 : 1_250;
    };

    const report = await runReadiness([check('db', async () => undefined)], { now });

    expect(report.checks.db).toEqual({ status: 'up', latencyMs: 250 });
  });

  it('measures latency for a failing check using the injected now() function', async () => {
    let calls = 0;
    const now = () => {
      calls += 1;
      return calls === 1 ? 1_000 : 1_400;
    };

    const report = await runReadiness(
      [
        check('db', async () => {
          throw new Error('down');
        }),
      ],
      { now },
    );

    expect(report.checks.db).toEqual({ status: 'down', latencyMs: 400 });
  });

  it('runs checks in parallel rather than in series', async () => {
    const order: string[] = [];
    const report = await runReadiness([
      check('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('slow');
      }),
      check('fast', async () => {
        order.push('fast');
      }),
    ]);

    expect(report.ok).toBe(true);
    expect(order).toEqual(['fast', 'slow']);
  });

  it('returns ok:true with an empty checks object when there are no checks', async () => {
    const report = await runReadiness([]);
    expect(report).toEqual({ ok: true, checks: {} });
  });
});
