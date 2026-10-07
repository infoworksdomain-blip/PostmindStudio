// T23 queue-capacity model. A deterministic discrete-event simulation of the BullMQ lanes when many
// organisations approve a month plan at the same moment. It compares the original layout
// ("before": every post generated at once, compose holding an orchestration slot through the whole
// Shotstack render) with rolling generation plus an async render lane ("after"). Pure: virtual
// time, no timers, no Redis, no database, so the same options always give the same numbers.

import { ValidationError } from '@/lib/errors';
import {
  DEFAULT_CAPACITY_OPTIONS,
  PRIORITY,
  eligibility,
  expectedGenerationSec,
  itemSteps,
  kindAt,
  slotTimes,
  validateCapacityOptions,
  type CapacityOptions,
  type CapacityResult,
  type ItemKind,
  type LaneName,
  type Step,
} from './capacity-options';
import { EventLoop, SimLane } from './capacity-sim';
import { percentile, type Distribution } from './report';

export * from './capacity-options';
export { renderCapacityMarkdown } from './capacity-report';
export type { LaneStats } from './capacity-sim';

interface SimItem {
  organisation: number;
  position: number;
  slotSec: number;
  steps: readonly Step[];
  expectedSec: number;
  /** Eligible at t = 0 (the initial backlog). */
  initial: boolean;
  started: boolean;
  readyAt?: number;
}

interface PlanState {
  items: SimItem[];
  /** Every item before this index has started; items start (mostly) in slot order. */
  next: number;
  generating: number;
}

/**
 * Distribution without spreading the values into Math.max, which overflows the argument limit for
 * the month-long tick series once days or the tick rate are raised.
 */
function summarise(values: readonly number[]): Distribution {
  const total = values.reduce((sum, v) => sum + v, 0);
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.reduce((m, v) => (v > m ? v : m), 0),
    mean: values.length ? total / values.length : 0,
  };
}

function buildLanes(loop: EventLoop, o: CapacityOptions): Map<LaneName, SimLane> {
  const names: LaneName[] =
    o.mode === 'after' ? ['orchestration', 'render', 'assets'] : ['orchestration', 'assets'];
  return new Map(names.map((name) => [name, new SimLane(loop, name, o.lanes[name])]));
}

function buildPlans(o: CapacityOptions): PlanState[] {
  const chains = new Map<ItemKind, { steps: Step[]; expectedSec: number }>();
  const chainFor = (kind: ItemKind) => {
    const cached = chains.get(kind);
    if (cached) return cached;
    const steps = itemSteps(kind, o);
    const chain = { steps, expectedSec: expectedGenerationSec(steps) };
    chains.set(kind, chain);
    return chain;
  };
  const slots = slotTimes(o);
  return Array.from({ length: o.organisations }, (_, organisation) => ({
    next: 0,
    generating: 0,
    items: slots.map((slotSec, position) => {
      const chain = chainFor(kindAt(position, o.mix));
      const rule = eligibility(o, { position, slotSec, nowSec: 0, expectedSec: chain.expectedSec });
      return {
        organisation,
        position,
        slotSec,
        steps: chain.steps,
        expectedSec: chain.expectedSec,
        initial: rule !== 'not_yet',
        started: false,
      };
    }),
  }));
}

export function runCapacityScenario(
  options: CapacityOptions = DEFAULT_CAPACITY_OPTIONS,
): CapacityResult {
  const o = options;
  validateCapacityOptions(o);
  const loop = new EventLoop();
  const lanes = buildLanes(loop, o);
  const plans = buildPlans(o);
  const items = plans.flatMap((p) => p.items);
  const tickWaits: number[] = [];
  let ready = 0;

  const lane = (name: LaneName): SimLane => {
    const found = lanes.get(name);
    if (!found) throw new ValidationError(`lane ${name} is not configured for this scenario`);
    return found;
  };

  const runChain = (
    steps: readonly Step[],
    i: number,
    priority: number,
    done: () => void,
  ): void => {
    const step = steps[i];
    if (!step) return done();
    const next = () => runChain(steps, i + 1, priority, done);
    if (step.kind === 'wait') return loop.after(step.sec, next);
    if (step.kind === 'job') {
      return lane(step.lane).enqueue({ priority, holdSec: step.holdSec, onDone: next });
    }
    let remaining = step.holdSecs.length;
    if (remaining === 0) return next();
    for (const holdSec of step.holdSecs) {
      lane(step.lane).enqueue({
        priority,
        holdSec,
        onDone: () => {
          remaining -= 1;
          if (remaining === 0) next();
        },
      });
    }
  };

  const start = (plan: PlanState, item: SimItem, priority: number) => {
    item.started = true;
    plan.generating += 1;
    runChain(item.steps, 0, priority, () => {
      item.readyAt = loop.now;
      plan.generating -= 1;
      ready += 1;
    });
  };

  // How far ahead of `now` a queued item can be and still be late: past this the runner can stop
  // scanning a plan that is at its concurrency limit.
  const lateHorizon =
    o.mode === 'after'
      ? items.reduce((m, it) => Math.max(m, it.expectedSec), 0) * o.lateFactor
      : Number.NEGATIVE_INFINITY;

  const advancePlan = (plan: PlanState) => {
    for (let i = plan.next; i < plan.items.length; i += 1) {
      const item = plan.items[i];
      if (!item) break;
      if (item.started) continue;
      const rule = eligibility(o, {
        position: item.position,
        slotSec: item.slotSec,
        nowSec: loop.now,
        expectedSec: item.expectedSec,
      });
      if (rule === 'not_yet') break;
      // Late items cannot wait for the plan's concurrency budget: they would miss their slot.
      if (rule === 'late') {
        start(plan, item, PRIORITY.normal);
        continue;
      }
      if (plan.generating >= o.planConcurrency) {
        if (item.slotSec - loop.now >= lateHorizon) break;
        continue;
      }
      start(plan, item, rule === 'immediate' ? PRIORITY.normal : PRIORITY.low);
    }
    while (plan.items[plan.next]?.started) plan.next += 1;
  };

  const runnerTick = () => {
    plans.forEach(advancePlan);
    if (plans.some((p) => p.next < p.items.length)) loop.after(o.runnerIntervalSec, runnerTick);
  };

  const platformTick = () => {
    lane('orchestration').enqueue({
      priority: o.platformTickPriority,
      holdSec: o.latencies.tickHoldSec,
      onStart: (waitSec) => tickWaits.push(waitSec),
      onDone: () => undefined,
    });
    if (ready < items.length) loop.after(o.platformTickIntervalSec, platformTick);
  };

  loop.at(0, runnerTick);
  loop.at(o.platformTickOffsetSec, platformTick);
  loop.run();

  const readyAt = (it: SimItem) => it.readyAt ?? Number.POSITIVE_INFINITY;
  const maxReady = (list: readonly SimItem[]) =>
    list.reduce((m, it) => Math.max(m, readyAt(it)), 0);
  const initial = items.filter((it) => it.initial);
  const firstReady = plans.map((p) =>
    p.items.reduce((m, it) => Math.min(m, readyAt(it)), Number.POSITIVE_INFINITY),
  );

  return {
    name: o.name,
    mode: o.mode,
    organisations: o.organisations,
    items: items.length,
    itemsReady: ready,
    drainSec: maxReady(items),
    initialBacklogItems: initial.length,
    initialBacklogDrainSec: maxReady(initial),
    timeToFirstReadySec: summarise(firstReady),
    lateItems: items.filter((it) => readyAt(it) > it.slotSec - o.readyMarginSec).length,
    tickWaitSec: summarise(tickWaits),
    lanes: [...lanes.values()].map((l) => l.stats()),
  };
}
