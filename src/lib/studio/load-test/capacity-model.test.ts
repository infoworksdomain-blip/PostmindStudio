import { beforeAll, describe, expect, it } from 'vitest';
import { ValidationError } from '@/lib/errors';
import {
  DEFAULT_CAPACITY_OPTIONS,
  DEFAULT_MIX,
  PRIORITY,
  afterScenario,
  beforeScenario,
  clipLatencies,
  eligibility,
  expectedGenerationSec,
  itemSteps,
  kindAt,
  renderCapacityMarkdown,
  runCapacityScenario,
  slotTimes,
  type CapacityOptions,
  type CapacityResult,
} from './capacity-model';
import { EventLoop, MinHeap, SimLane } from './capacity-sim';

/** One organisation, one post per day, one day: hand-checkable timings. */
function tiny(mode: 'before' | 'after', overrides: Partial<CapacityOptions> = {}): CapacityOptions {
  const base = mode === 'before' ? beforeScenario() : afterScenario();
  return { ...base, organisations: 1, days: 1, postsPerDay: 1, ...overrides };
}

describe('capacity engine', () => {
  it('pops a min-heap in order', () => {
    const heap = new MinHeap<number>((a, b) => a < b);
    [5, 1, 4, 2, 3].forEach((n) => heap.push(n));
    const out = [heap.pop(), heap.pop(), heap.pop(), heap.pop(), heap.pop(), heap.pop()];
    expect(out).toEqual([1, 2, 3, 4, 5, undefined]);
  });

  it('serves one lane FIFO within a priority', () => {
    const loop = new EventLoop();
    const lane = new SimLane(loop, 'l', 1);
    const done: Array<[string, number]> = [];
    lane.enqueue({ priority: 5, holdSec: 5, onDone: () => done.push(['a', loop.now]) });
    lane.enqueue({ priority: 5, holdSec: 3, onDone: () => done.push(['b', loop.now]) });
    loop.run();
    expect(done).toEqual([
      ['a', 5],
      ['b', 8],
    ]);
    expect(lane.stats()).toMatchObject({ jobs: 2, peakDepth: 1, busySec: 8 });
  });

  it('starts the lower priority number first once a slot frees', () => {
    const loop = new EventLoop();
    const lane = new SimLane(loop, 'l', 1);
    const order: string[] = [];
    lane.enqueue({ priority: 5, holdSec: 2, onDone: () => order.push('busy') });
    lane.enqueue({ priority: PRIORITY.low, holdSec: 1, onDone: () => order.push('low') });
    lane.enqueue({ priority: PRIORITY.high, holdSec: 1, onDone: () => order.push('high') });
    loop.run();
    expect(order).toEqual(['busy', 'high', 'low']);
  });

  it('frees the slot during an external wait but blocks it while a job holds the wait', () => {
    const run = (holdThroughRender: boolean) => {
      const loop = new EventLoop();
      const lane = new SimLane(loop, 'render', 1);
      let otherStartedAt = -1;
      if (holdThroughRender) {
        lane.enqueue({ priority: 5, holdSec: 3 + 49 + 4, onDone: () => undefined });
      } else {
        lane.enqueue({
          priority: 5,
          holdSec: 3,
          onDone: () =>
            loop.after(49, () =>
              lane.enqueue({ priority: 5, holdSec: 4, onDone: () => undefined }),
            ),
        });
      }
      lane.enqueue({
        priority: 5,
        holdSec: 10,
        onStart: () => (otherStartedAt = loop.now),
        onDone: () => undefined,
      });
      loop.run();
      return otherStartedAt;
    };
    expect(run(false)).toBe(3);
    expect(run(true)).toBe(56);
  });
});

describe('capacity options', () => {
  it('repeats the 40/30/20/10 mix by item position', () => {
    const counts = DEFAULT_MIX.reduce<Record<string, number>>(
      (acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }),
      {},
    );
    expect(counts).toEqual({ carousel: 4, slideshow: 3, wall_of_text: 2, ai_video: 1 });
    expect(kindAt(9, DEFAULT_MIX)).toBe('ai_video');
    expect(kindAt(10, DEFAULT_MIX)).toBe('carousel');
  });

  it('places slots from day 1 09:00 UTC relative to day 0 08:00', () => {
    const slots = slotTimes(DEFAULT_CAPACITY_OPTIONS);
    expect(slots).toHaveLength(84);
    expect(slots.slice(0, 3)).toEqual([90_000, 104_400, 122_400]);
  });

  it('spreads AI clips evenly around a 105 s mean', () => {
    const clips = clipLatencies(DEFAULT_CAPACITY_OPTIONS.latencies);
    expect(clips).toEqual([30, 80, 130, 180]);
  });

  it('holds orchestration through Shotstack before, and waits slot-free on render after', () => {
    expect(itemSteps('slideshow', beforeScenario())).toContainEqual({
      kind: 'job',
      lane: 'orchestration',
      holdSec: 56,
    });
    const after = itemSteps('ai_video', afterScenario());
    expect(after).toContainEqual({ kind: 'job', lane: 'render', holdSec: 28 });
    expect(after).toContainEqual({ kind: 'wait', sec: 49 });
    expect(expectedGenerationSec(after)).toBe(12 + 180 + 28 + 49 + 4 + 3);
    expect(itemSteps('slideshow', afterScenario({ callbacks: false }))).toContainEqual({
      kind: 'wait',
      sec: 60,
    });
    expect(itemSteps('carousel', afterScenario())[1]).toMatchObject({ lane: 'render' });
  });

  it('applies the rolling eligibility rule', () => {
    const o = afterScenario();
    const at = (position: number, slotSec: number, expectedSec = 70) =>
      eligibility(o, { position, slotSec, nowSec: 0, expectedSec });
    expect(at(0, 20 * 86_400)).toBe('immediate');
    expect(at(5, 71 * 3600)).toBe('window');
    expect(at(5, 73 * 3600)).toBe('not_yet');
    expect(at(5, 100, 70)).toBe('late');
    expect(
      eligibility(beforeScenario(), { position: 80, slotSec: 9e6, nowSec: 0, expectedSec: 1 }),
    ).toBe('window');
  });

  it('rejects impossible options', () => {
    expect(() => runCapacityScenario(afterScenario({ organisations: 0 }))).toThrow(ValidationError);
    expect(() =>
      runCapacityScenario(afterScenario({ lanes: { orchestration: 4, assets: 8, render: 0 } })),
    ).toThrow(ValidationError);
  });
});

describe('capacity scenarios (small)', () => {
  it('matches hand-computed generation times for one item', () => {
    const slideshow = (mode: 'before' | 'after', callbacks = true) =>
      runCapacityScenario(tiny(mode, { mix: ['slideshow'], callbacks })).drainSec;
    // plan 6 + populate 4 + compose (3 + 49 + 4) + gate 3.
    expect(slideshow('before')).toBe(69);
    expect(slideshow('after')).toBe(69);
    // The delayed poll fires on the 20 s boundary after the 49 s render: 60 s instead of 49.
    expect(slideshow('after', false)).toBe(80);
    expect(runCapacityScenario(tiny('after', { mix: ['carousel'] })).drainSec).toBe(32);
  });

  it('is deterministic', () => {
    const o = afterScenario({ organisations: 5, days: 4 });
    expect(runCapacityScenario(o)).toEqual(runCapacityScenario(o));
  });

  it('renders a before/after Markdown table', () => {
    const md = renderCapacityMarkdown([
      runCapacityScenario(tiny('before')),
      runCapacityScenario(tiny('after')),
    ]);
    expect(md).toContain('| Measure | before | after |');
    expect(md).toContain('Initial backlog drain');
  });
});

describe('capacity scenarios (100 organisations, full month)', () => {
  let before: CapacityResult;
  let after: CapacityResult;

  beforeAll(() => {
    before = runCapacityScenario(beforeScenario());
    after = runCapacityScenario(afterScenario());
  });

  it('generates every item in both layouts', () => {
    expect(before.itemsReady).toBe(8400);
    expect(after.itemsReady).toBe(8400);
  });

  it('drains the initial backlog an order of magnitude faster', () => {
    expect(after.initialBacklogItems).toBe(600);
    expect(after.initialBacklogDrainSec).toBeLessThan(before.drainSec / 10);
    expect(after.initialBacklogDrainSec).toBeLessThan(2 * 3600);
  });

  it('misses no slot and gets every organisation a first post sooner', () => {
    expect(after.lateItems).toBe(0);
    expect(after.timeToFirstReadySec.p95).toBeLessThan(before.timeToFirstReadySec.p95 / 3);
  });

  it('keeps platform ticks moving on the orchestration lane', () => {
    expect(after.tickWaitSec.p95).toBeLessThan(10);
  });

  it('removes the t=0 tick wait when ticks run at high priority', () => {
    const high = runCapacityScenario(
      afterScenario({ days: 3, platformTickPriority: PRIORITY.high }),
    );
    expect(high.tickWaitSec.max).toBeLessThan(15);
    expect(high.lateItems).toBe(0);
  });
});
