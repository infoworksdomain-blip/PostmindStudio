import type { ContentPlanItem } from '@prisma/client';
import { ValidationError } from '../../errors';

// BACKLOG 23.6 — rolling generation (production 2026-10-06: a full-month automation started all
// 84 posts at once and every post on the platform queued behind them). A month plan's (or an
// automation period's) posts are generated only shortly before they go out:
//
//   due        the slot is within the lead window (STUDIO_PLAN_LEAD_HOURS, default 72 h);
//   immediate  one of the plan's first STUDIO_PLAN_IMMEDIATE_ITEMS posts (default 3, the first
//              day at 3 a day), so the owner sees results at once;
//   urgent     the slot is closer than twice the post's expected generation time (a plan approved
//              late, or held by the kill switch, a cost cap or the daily limit): started first, at
//              normal queue priority and outside the per-plan concurrency;
//   waiting    everything else: its project stays a DRAFT and the runner (every minute) starts it
//              when it enters the window. The calendar shows "Scheduled to be created on <date>".
//
// Allowance is unchanged: every post's allowance is reserved when the plan is approved
// ("Generate and schedule"), as before 23.6, so an approved month can never run out half way;
// a post that never runs gives its reservation back (content-plan-run.ts skipItem).

export const DEFAULT_LEAD_HOURS = 72;
export const MAX_LEAD_HOURS = 24 * 31;
export const DEFAULT_IMMEDIATE_ITEMS = 3;
export const MAX_IMMEDIATE_ITEMS = 31;
/** An urgent post gets twice its typical generation time (queues are not always empty). */
export const URGENT_FACTOR = 2;
const HOUR_MS = 3_600_000;

/**
 * Typical time from start to ready per post kind / automation format, queue waits included
 * (production 2026-10-06: carousel ~26 s alone, Shotstack p50 49 s, AI clips 30–180 s).
 */
export const EXPECTED_GENERATION_MS: Readonly<Record<string, number>> = {
  CAROUSEL: 10 * 60_000,
  carousel: 10 * 60_000,
  SLIDESHOW: 20 * 60_000,
  slideshow: 20 * 60_000,
  wall_of_text: 20 * 60_000,
  hook_demo: 30 * 60_000,
  VIDEO: 45 * 60_000,
  ai_video: 45 * 60_000,
  ugc: 60 * 60_000,
};
const DEFAULT_EXPECTED_MS = 45 * 60_000;

export interface RollingSettings {
  leadMs: number;
  immediateItems: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function boundedInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ValidationError(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

/** STUDIO_PLAN_LEAD_HOURS (1–744, default 72) and STUDIO_PLAN_IMMEDIATE_ITEMS (0–31, default 3). */
export function rollingSettings(env: Env = process.env): RollingSettings {
  return {
    leadMs:
      boundedInt(env, 'STUDIO_PLAN_LEAD_HOURS', DEFAULT_LEAD_HOURS, 1, MAX_LEAD_HOURS) * HOUR_MS,
    immediateItems: boundedInt(
      env,
      'STUDIO_PLAN_IMMEDIATE_ITEMS',
      DEFAULT_IMMEDIATE_ITEMS,
      0,
      MAX_IMMEDIATE_ITEMS,
    ),
  };
}

type RollingItem = Pick<ContentPlanItem, 'id' | 'slotAt' | 'position' | 'status' | 'kind'> &
  Partial<Pick<ContentPlanItem, 'format' | 'startedAt'>>;

export function expectedGenerationMs(item: Pick<RollingItem, 'kind' | 'format'>): number {
  return (
    (item.format ? EXPECTED_GENERATION_MS[item.format] : undefined) ??
    EXPECTED_GENERATION_MS[item.kind] ??
    DEFAULT_EXPECTED_MS
  );
}

function bySlot(a: RollingItem, b: RollingItem): number {
  return a.slotAt.getTime() - b.slotAt.getTime() || a.position - b.position;
}

/** The plan's first N posts by slot (removed / skipped ones do not count). */
export function immediateIds(
  items: readonly RollingItem[],
  settings: RollingSettings,
): Set<string> {
  return new Set(
    items
      .filter((i) => i.status !== 'REMOVED' && i.status !== 'SKIPPED')
      .sort(bySlot)
      .slice(0, settings.immediateItems)
      .map((i) => i.id),
  );
}

export type Readiness = 'urgent' | 'immediate' | 'due' | 'waiting';

export function readinessOf(
  item: RollingItem,
  now: number,
  settings: RollingSettings,
  immediate: ReadonlySet<string>,
): Readiness {
  const untilSlot = item.slotAt.getTime() - now;
  if (untilSlot < expectedGenerationMs(item) * URGENT_FACTOR) return 'urgent';
  if (immediate.has(item.id)) return 'immediate';
  if (untilSlot <= settings.leadMs) return 'due';
  return 'waiting';
}

export interface StartPlan<T extends RollingItem> {
  /** Started first, at normal priority, outside the plan's concurrency. */
  urgent: T[];
  /** Started within the plan's concurrency, in this order (immediate ones at normal priority). */
  ready: Array<{ item: T; priority: 'normal' | 'batch' }>;
  /** Not yet in the window. */
  waiting: T[];
}

/** Which QUEUED posts the runner may start now, and how (pure; content-plan-run.ts uses it). */
export function selectStarts<T extends RollingItem>(
  all: readonly T[],
  now: number,
  settings: RollingSettings,
): StartPlan<T> {
  const immediate = immediateIds(all, settings);
  const plan: StartPlan<T> = { urgent: [], ready: [], waiting: [] };
  for (const item of [...all].sort(bySlot)) {
    if (item.status !== 'QUEUED') continue;
    const readiness = readinessOf(item, now, settings, immediate);
    if (readiness === 'urgent') plan.urgent.push(item);
    else if (readiness === 'waiting') plan.waiting.push(item);
    else plan.ready.push({ item, priority: readiness === 'immediate' ? 'normal' : 'batch' });
  }
  return plan;
}

/**
 * When the runner will start a waiting post (the calendar's "Scheduled to be created on"), or
 * null when it is not waiting (already started, immediate, or in the window).
 */
export function createsAtOf(
  item: RollingItem,
  all: readonly RollingItem[],
  now: number,
  settings: RollingSettings,
): Date | null {
  if (item.status !== 'QUEUED' || item.startedAt) return null;
  if (readinessOf(item, now, settings, immediateIds(all, settings)) !== 'waiting') return null;
  return new Date(item.slotAt.getTime() - settings.leadMs);
}

/** True when a QUEUED post is only waiting for its window (the plan may count it as settled). */
export function isWaitingForWindow(
  item: RollingItem,
  all: readonly RollingItem[],
  now: number,
  settings: RollingSettings,
): boolean {
  return createsAtOf(item, all, now, settings) !== null;
}
