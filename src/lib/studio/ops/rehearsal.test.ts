import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import {
  activeJobsByQueue,
  formatHaltReport,
  formatReport,
  KILL_SWITCH_SLO_MS,
  observeHalt,
  parsePlan,
  publishQueueActive,
  REHEARSAL_LEVELS,
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

describe('platform level (Phase 14.6)', () => {
  it('parses platform with a target', () => {
    expect(parsePlan(['platform', 'tiktok'])).toMatchObject({
      level: 'platform',
      target: 'tiktok',
    });
    expect(() => parsePlan(['platform'])).toThrow(ValidationError);
    expect(REHEARSAL_LEVELS).toEqual(['provider', 'platform', 'project', 'workspace', 'global']);
  });

  it('reads the publish queue active gauge', () => {
    expect(publishQueueActive(exposition({ 'studio-publish': 2, 'studio-assets': 5 }))).toBe(2);
    expect(publishQueueActive(exposition({ 'studio-assets': 5 }))).toBe(0);
  });
});

describe('observeHalt', () => {
  const T0 = 1_000_000;
  function probeClock(frames: Array<{ started: number; last: number | null; inFlight: number }>) {
    let t = T0;
    let i = 0;
    return {
      probe: async () => {
        const f = frames[Math.min(i++, frames.length - 1)] as (typeof frames)[number];
        return {
          startedSinceEngage: f.started,
          lastStartedAt: f.last === null ? null : T0 + f.last,
          inFlight: f.inFlight,
        };
      },
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  }

  it('passes when the last in-scope start is within 60 s and it stays quiet', async () => {
    const deps = probeClock([
      { started: 1, last: 5_000, inFlight: 2 },
      { started: 2, last: 20_000, inFlight: 1 },
      { started: 2, last: 20_000, inFlight: 0 },
    ]);
    const result = await observeHalt(deps, {
      startedAt: T0,
      intervalMs: 10_000,
      observeMs: 90_000,
    });
    expect(result).toMatchObject({ halted: true, elapsedMs: 20_000, withinSlo: true });
    expect(result.samples.at(-1)?.atMs).toBe(90_000);
    expect(result.samples[1]?.lastStartMs).toBe(20_000);
  });

  it('reports 0 s when nothing started after engaging', async () => {
    const deps = probeClock([{ started: 0, last: null, inFlight: 3 }]);
    const result = await observeHalt(deps, { startedAt: T0, intervalMs: 30_000 });
    expect(result).toMatchObject({ halted: true, elapsedMs: 0, withinSlo: true });
  });

  it('fails when work keeps starting inside the quiet window', async () => {
    const frames = Array.from({ length: 10 }, (_, i) => ({
      started: i,
      last: i * 10_000,
      inFlight: 1,
    }));
    const result = await observeHalt(probeClock(frames), {
      startedAt: T0,
      intervalMs: 10_000,
      observeMs: 90_000,
    });
    expect(result.halted).toBe(false);
    expect(result.withinSlo).toBe(false);
    expect(formatHaltReport(parsePlan(['provider', 'runway']), result)).toContain('FAIL');
  });

  it('requires idle when asked (platform: publishing still in flight)', async () => {
    const deps = probeClock([{ started: 0, last: null, inFlight: 1 }]);
    const result = await observeHalt(deps, {
      startedAt: T0,
      intervalMs: 30_000,
      requireIdle: true,
    });
    expect(result.halted).toBe(false);
    expect(formatHaltReport(parsePlan(['platform', 'tiktok']), result)).toContain('in flight (1)');
  });

  it('fails the SLO when the last start came after 60 s', async () => {
    const deps = probeClock([{ started: 1, last: 65_000, inFlight: 0 }]);
    const result = await observeHalt(deps, {
      startedAt: T0,
      intervalMs: 50_000,
      observeMs: 100_000,
    });
    expect(result).toMatchObject({ halted: true, elapsedMs: 65_000, withinSlo: false });
    expect(formatHaltReport(parsePlan(['workspace', 'org-1']), result)).toContain(
      'over the 60s SLO',
    );
  });

  it('rejects invalid options', async () => {
    await expect(
      observeHalt(probeClock([{ started: 0, last: null, inFlight: 0 }]), {
        startedAt: T0,
        observeMs: 10_000,
        quietMs: 30_000,
      }),
    ).rejects.toThrow(ValidationError);
  });
});
