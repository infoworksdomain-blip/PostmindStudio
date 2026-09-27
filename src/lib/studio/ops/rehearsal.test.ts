import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import {
  activeJobsByQueue,
  formatReport,
  KILL_SWITCH_SLO_MS,
  parsePlan,
  totalActive,
  waitForDrain,
} from './rehearsal';

const exposition = (active: Record<string, number>) =>
  [
    '# HELP studio_queue_jobs Jobs per queue and state',
    '# TYPE studio_queue_jobs gauge',
    ...Object.entries(active).flatMap(([queue, n]) => [
      `studio_queue_jobs{queue="${queue}",state="active"} ${n}`,
      `studio_queue_jobs{queue="${queue}",state="waiting"} 7`,
    ]),
    'studio_jobs_total{job="plan-project",outcome="succeeded"} 3',
  ].join('\n');

function clock(stepMs: number, frames: Array<Record<string, number>>) {
  let t = 0;
  let i = 0;
  return {
    scrape: async () => exposition(frames[Math.min(i++, frames.length - 1)] ?? {}),
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      void stepMs;
    },
  };
}

describe('activeJobsByQueue', () => {
  it('sums only active-state samples per queue', () => {
    const text = exposition({ 'studio-assets': 2, 'studio-publish': 1 });
    expect(activeJobsByQueue(text)).toEqual({ 'studio-assets': 2, 'studio-publish': 1 });
    expect(totalActive(activeJobsByQueue(text))).toBe(3);
  });

  it('ignores unrelated and malformed lines', () => {
    expect(activeJobsByQueue('studio_queue_jobs{queue="x",state="active"} nope\nfoo 1')).toEqual(
      {},
    );
    expect(activeJobsByQueue('studio_queue_jobs{state="active"} 4')).toEqual({});
  });
});

describe('waitForDrain', () => {
  it('reports the first zero of a stable run and passes within the SLO', async () => {
    const deps = clock(2000, [{ a: 3 }, { a: 1 }, { a: 0 }, { a: 0 }]);
    const result = await waitForDrain(deps, { startedAt: 0, intervalMs: 2000 });
    expect(result).toMatchObject({ drained: true, elapsedMs: 4000, withinSlo: true });
    expect(result.samples).toHaveLength(4);
  });

  it('resets the streak when a job is picked up between scrapes', async () => {
    const deps = clock(2000, [{ a: 0 }, { a: 1 }, { a: 0 }, { a: 0 }]);
    const result = await waitForDrain(deps, { startedAt: 0, intervalMs: 2000 });
    expect(result.elapsedMs).toBe(4000);
  });

  it('fails the SLO when draining takes longer than 60s', async () => {
    const frames = [...Array(35).fill({ a: 1 }), { a: 0 }, { a: 0 }];
    const result = await waitForDrain(clock(2000, frames), { startedAt: 0, intervalMs: 2000 });
    expect(result.drained).toBe(true);
    expect(result.elapsedMs).toBeGreaterThan(KILL_SWITCH_SLO_MS);
    expect(result.withinSlo).toBe(false);
  });

  it('gives up at the timeout', async () => {
    const result = await waitForDrain(clock(1000, [{ a: 1 }]), {
      startedAt: 0,
      intervalMs: 1000,
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({ drained: false, withinSlo: false });
  });

  it('rejects invalid options', async () => {
    await expect(waitForDrain(clock(1, [{}]), { startedAt: 0, intervalMs: 0 })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('parsePlan', () => {
  it('accepts global without a target and drops a stray one', () => {
    expect(parsePlan(['global', 'x'])).toMatchObject({ level: 'global', target: undefined });
  });

  it('requires a target for scoped levels', () => {
    expect(() => parsePlan(['workspace'])).toThrow(ValidationError);
    expect(parsePlan(['provider', 'runway'])).toMatchObject({
      level: 'provider',
      target: 'runway',
    });
  });

  it('rejects unknown levels', () => {
    expect(() => parsePlan(['everything'])).toThrow(ValidationError);
  });
});

describe('formatReport', () => {
  const plan = parsePlan(['global']);
  it('prints PASS / FAIL verdicts', () => {
    const sample = [{ atMs: 2000, active: { a: 0 } }];
    expect(
      formatReport(plan, { drained: true, elapsedMs: 2000, withinSlo: true, samples: sample }),
    ).toContain('PASS — drained in 2.0s');
    expect(
      formatReport(plan, { drained: true, elapsedMs: 70000, withinSlo: false, samples: sample }),
    ).toContain('over the 60s SLO');
    expect(
      formatReport(plan, { drained: false, elapsedMs: 180000, withinSlo: false, samples: [] }),
    ).toContain('did not drain');
  });
});
