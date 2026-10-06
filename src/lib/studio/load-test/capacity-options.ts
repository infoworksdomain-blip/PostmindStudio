// T23 queue-capacity model: scenario options, job chains and the rolling-generation rule. The
// simulation itself is capacity-model.ts. Latencies are production medians (2026-10-06);
// everything is overridable.

import { ValidationError } from '@/lib/errors';
import type { LaneStats } from './capacity-sim';
import type { Distribution } from './report';

export const PRIORITY = { high: 1, normal: 5, low: 10 } as const;

export type ItemKind = 'carousel' | 'slideshow' | 'wall_of_text' | 'ai_video';
export type LaneName = 'orchestration' | 'assets' | 'render';
export type ScenarioMode = 'before' | 'after';

export interface CapacityLatencies {
  /** plan-project with one Claude call (carousel, slideshow, wall of text). */
  planSec: number;
  /** plan-project for AI video (two Claude calls). */
  aiVideoPlanSec: number;
  renderCarouselSec: number;
  populateSlideshowSec: number;
  qualityGateSec: number;
  stockFootageSec: number;
  aiClipCount: number;
  /** AI clip latencies are spread evenly over [min, max]; each clip holds an assets slot. */
  aiClipMinSec: number;
  aiClipMaxSec: number;
  composePrepSec: number;
  /** Extra compose prep for AI video (music). */
  musicSec: number;
  shotstackSec: number;
  composeFinishSec: number;
  /** poll-render delay step when render callbacks are off. */
  renderPollIntervalSec: number;
  tickHoldSec: number;
}

export interface CapacityOptions {
  name: string;
  mode: ScenarioMode;
  organisations: number;
  days: number;
  postsPerDay: number;
  /** Slot hours (UTC) each day; the run starts on day 0 at `startHourUtc`, slots from day 1. */
  slotHoursUtc: readonly number[];
  startHourUtc: number;
  /** Worker concurrency per lane; `render` is unused in "before". */
  lanes: Readonly<Record<LaneName, number>>;
  latencies: CapacityLatencies;
  /** Format by item position, repeating. */
  mix: readonly ItemKind[];
  planConcurrency: number;
  leadWindowHours: number;
  immediateItems: number;
  /** An item is late when slot - now < expected generation time x lateFactor. */
  lateFactor: number;
  callbacks: boolean;
  runnerIntervalSec: number;
  platformTickIntervalSec: number;
  /** First platform tick, offset from the runner so the two do not always coincide. */
  platformTickOffsetSec: number;
  platformTickPriority: number;
  /** An item is counted late when it becomes ready after slot - this margin. */
  readyMarginSec: number;
}

export const DEFAULT_LATENCIES: CapacityLatencies = {
  planSec: 6,
  aiVideoPlanSec: 12,
  renderCarouselSec: 26,
  populateSlideshowSec: 4,
  qualityGateSec: 3,
  stockFootageSec: 3,
  aiClipCount: 4,
  aiClipMinSec: 30,
  aiClipMaxSec: 180,
  composePrepSec: 3,
  musicSec: 25,
  shotstackSec: 49,
  composeFinishSec: 4,
  renderPollIntervalSec: 20,
  tickHoldSec: 1,
};

/** 40% carousel, 30% slideshow, 20% wall of text, 10% AI video. */
export const DEFAULT_MIX: readonly ItemKind[] = [
  'carousel',
  'slideshow',
  'wall_of_text',
  'carousel',
  'slideshow',
  'carousel',
  'wall_of_text',
  'slideshow',
  'carousel',
  'ai_video',
];

export const DEFAULT_CAPACITY_OPTIONS: CapacityOptions = {
  name: 'after',
  mode: 'after',
  organisations: 100,
  days: 28,
  postsPerDay: 3,
  slotHoursUtc: [9, 13, 18],
  startHourUtc: 8,
  lanes: { orchestration: 4, assets: 8, render: 3 },
  latencies: DEFAULT_LATENCIES,
  mix: DEFAULT_MIX,
  planConcurrency: 10,
  leadWindowHours: 72,
  immediateItems: 3,
  lateFactor: 2,
  callbacks: true,
  runnerIntervalSec: 60,
  platformTickIntervalSec: 60,
  platformTickOffsetSec: 30,
  platformTickPriority: PRIORITY.normal,
  readyMarginSec: 45 * 60,
};

export function beforeScenario(overrides: Partial<CapacityOptions> = {}): CapacityOptions {
  return {
    ...DEFAULT_CAPACITY_OPTIONS,
    name: 'before',
    mode: 'before',
    lanes: { orchestration: 4, assets: 8, render: 0 },
    // Before 23.6 the runners ran at the plan tier's (normal) priority.
    platformTickPriority: PRIORITY.normal,
    ...overrides,
  };
}

export function afterScenario(overrides: Partial<CapacityOptions> = {}): CapacityOptions {
  // 23.6: the runners run at HIGH priority (queues.ts RUNNER_JOBS).
  return { ...DEFAULT_CAPACITY_OPTIONS, platformTickPriority: PRIORITY.high, ...overrides };
}

/** One link of an item's job chain: a lane job, parallel lane jobs, or an external wait (no slot). */
export type Step =
  | { kind: 'job'; lane: LaneName; holdSec: number }
  | { kind: 'parallel'; lane: LaneName; holdSecs: readonly number[] }
  | { kind: 'wait'; sec: number };

/** Evenly spread clip latencies over [min, max] (mean = midpoint), deterministic. */
export function clipLatencies(l: CapacityLatencies): number[] {
  const n = Math.max(1, l.aiClipCount);
  if (n === 1) return [(l.aiClipMinSec + l.aiClipMaxSec) / 2];
  return Array.from(
    { length: n },
    (_, k) => l.aiClipMinSec + ((l.aiClipMaxSec - l.aiClipMinSec) * k) / (n - 1),
  );
}

function composeSteps(o: CapacityOptions, withMusic: boolean): Step[] {
  const l = o.latencies;
  const prep = l.composePrepSec + (withMusic ? l.musicSec : 0);
  if (o.mode === 'before') {
    // The old compose-video waited for Shotstack inside the job, holding an orchestration slot.
    const hold = prep + l.shotstackSec + l.composeFinishSec;
    return [{ kind: 'job', lane: 'orchestration', holdSec: hold }];
  }
  // Async render: submit, free the slot, poll-render finishes. Without callbacks the delayed poll
  // fires on the next poll-interval boundary after the render is done.
  const wait = o.callbacks
    ? l.shotstackSec
    : Math.ceil(l.shotstackSec / l.renderPollIntervalSec) * l.renderPollIntervalSec;
  return [
    { kind: 'job', lane: 'render', holdSec: prep },
    { kind: 'wait', sec: wait },
    { kind: 'job', lane: 'render', holdSec: l.composeFinishSec },
  ];
}

export function itemSteps(kind: ItemKind, o: CapacityOptions): Step[] {
  const l = o.latencies;
  const orch = (holdSec: number): Step => ({ kind: 'job', lane: 'orchestration', holdSec });
  const gate = orch(l.qualityGateSec);
  switch (kind) {
    case 'carousel':
      return [
        orch(l.planSec),
        {
          kind: 'job',
          lane: o.mode === 'before' ? 'orchestration' : 'render',
          holdSec: l.renderCarouselSec,
        },
      ];
    case 'slideshow':
      return [orch(l.planSec), orch(l.populateSlideshowSec), ...composeSteps(o, false), gate];
    case 'wall_of_text':
      return [
        orch(l.planSec),
        { kind: 'job', lane: 'assets', holdSec: l.stockFootageSec },
        ...composeSteps(o, false),
        gate,
      ];
    case 'ai_video':
      return [
        orch(l.aiVideoPlanSec),
        { kind: 'parallel', lane: 'assets', holdSecs: clipLatencies(l) },
        ...composeSteps(o, true),
        gate,
      ];
  }
}

/** Generation time with empty queues (the critical path through the chain). */
export function expectedGenerationSec(steps: readonly Step[]): number {
  return steps.reduce((sum, s) => {
    if (s.kind === 'job') return sum + s.holdSec;
    if (s.kind === 'wait') return sum + s.sec;
    return sum + Math.max(0, ...s.holdSecs);
  }, 0);
}

export function kindAt(position: number, mix: readonly ItemKind[]): ItemKind {
  return mix[position % mix.length] ?? 'carousel';
}

/** Slot times (seconds since the run start) for one plan, ascending. */
export function slotTimes(o: CapacityOptions): number[] {
  const hours = [...o.slotHoursUtc].sort((a, b) => a - b).slice(0, o.postsPerDay);
  const slots: number[] = [];
  for (let day = 1; day <= o.days; day += 1) {
    for (const h of hours) slots.push(day * 86_400 + (h - o.startHourUtc) * 3600);
  }
  return slots;
}

export interface EligibilityInput {
  position: number;
  slotSec: number;
  nowSec: number;
  expectedSec: number;
}

export type Eligibility = 'immediate' | 'late' | 'window' | 'not_yet';

/** Rolling-generation rule ("after"); "before" treats every item as eligible at once. */
export function eligibility(o: CapacityOptions, input: EligibilityInput): Eligibility {
  if (o.mode === 'before') return 'window';
  const lead = input.slotSec - input.nowSec;
  if (lead < input.expectedSec * o.lateFactor) return 'late';
  if (input.position < o.immediateItems) return 'immediate';
  if (lead <= o.leadWindowHours * 3600) return 'window';
  return 'not_yet';
}

export interface CapacityResult {
  name: string;
  mode: ScenarioMode;
  organisations: number;
  items: number;
  itemsReady: number;
  drainSec: number;
  initialBacklogItems: number;
  initialBacklogDrainSec: number;
  timeToFirstReadySec: Distribution;
  lateItems: number;
  tickWaitSec: Distribution;
  lanes: LaneStats[];
}

export function validateCapacityOptions(o: CapacityOptions): void {
  const positiveInts: Array<[string, number]> = [
    ['organisations', o.organisations],
    ['days', o.days],
    ['postsPerDay', o.postsPerDay],
    ['planConcurrency', o.planConcurrency],
    ['lanes.orchestration', o.lanes.orchestration],
    ['lanes.assets', o.lanes.assets],
    ['runnerIntervalSec', o.runnerIntervalSec],
    ['platformTickIntervalSec', o.platformTickIntervalSec],
  ];
  if (o.mode === 'after') positiveInts.push(['lanes.render', o.lanes.render]);
  for (const [field, value] of positiveInts) {
    if (!Number.isInteger(value) || value < 1) {
      throw new ValidationError(`${field} must be a positive integer`, { field, value });
    }
  }
  if (o.mix.length === 0) throw new ValidationError('mix must not be empty', { field: 'mix' });
  if (o.slotHoursUtc.length < o.postsPerDay) {
    throw new ValidationError('postsPerDay exceeds slotHoursUtc', { field: 'postsPerDay' });
  }
  if (o.leadWindowHours < 0 || o.immediateItems < 0 || o.lateFactor < 0) {
    throw new ValidationError('window, immediate items and late factor must be >= 0');
  }
}
