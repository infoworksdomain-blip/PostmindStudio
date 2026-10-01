// 20.9 "Plan my month" — the client's view of GET /api/studio/content-plans/:id and the pure
// helpers the screens share (grouping by day, counts, what the owner may still do). No React
// here, so every rule the screens rely on is unit-tested.

export type PlanStatus =
  'DRAFTING' | 'DRAFT' | 'GENERATING' | 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
export type ItemStatus =
  | 'PLANNED'
  | 'QUEUED'
  | 'GENERATING'
  | 'READY'
  | 'SCHEDULED'
  | 'POSTED'
  | 'HELD'
  | 'FAILED'
  | 'SKIPPED'
  | 'REMOVED';
export type ItemKind = 'VIDEO' | 'SLIDESHOW';

export const ITEM_STATUSES: readonly ItemStatus[] = [
  'PLANNED',
  'QUEUED',
  'GENERATING',
  'READY',
  'SCHEDULED',
  'POSTED',
  'HELD',
  'FAILED',
  'SKIPPED',
  'REMOVED',
];

export const PLAN_ANGLES = [
  'how_to',
  'product_feature',
  'behind_the_scenes',
  'offer',
  'testimonial',
  'seasonal',
  'custom',
] as const;
export type PlanAngle = (typeof PLAN_ANGLES)[number];

/** Status reasons the screens can explain (plans.reason.*); others show nothing. */
export const REASON_KEYS = [
  'slot_passed',
  'allowance',
  'removed_by_owner',
  'plan_cancelled',
  'not_started',
  'publish_failed',
  'safety_review',
  'content_safety_flag',
  'script_safety_flag',
] as const;
export type ReasonKey = (typeof REASON_KEYS)[number];

export interface PlanSlides {
  hook: string;
  points: string[];
  cta: string;
}

export interface PlanItem {
  id: string;
  position: number;
  slotAt: string;
  kind: ItemKind;
  angle: string;
  title: string;
  brief: string;
  slides: PlanSlides | null;
  calendarDay: string | null;
  status: ItemStatus;
  statusReason: string | null;
  projectId: string | null;
  /** 20.13: caption + hashtags per platform (drafted, editable). */
  postCopy?: Record<string, { caption: string; hashtags: string[]; title?: string }> | null;
}

export interface Plan {
  id: string;
  businessId: string;
  status: PlanStatus;
  startDate: string;
  days: number;
  timezone: string;
  windowStart: string;
  windowEnd: string;
  postsPerDay: number;
  useDripSlots: boolean;
  videoShare: number;
  platforms: string[];
  /** The accounts the posts go to (20.12: empty = made and saved for review, not scheduled). */
  targets?: Array<{ platform: string; connectionId: string | null }>;
  requestedCount: number;
  cappedReason: 'allowance' | 'cost_cap' | null;
  holdReason: 'kill_switch' | 'cost_cap' | 'daily_limit' | null;
  draftError: string | null;
  createdAt: string;
  scheduledAt: string | null;
  cancelledAt: string | null;
  counts: Record<ItemStatus, number>;
  estimate: { typicalPence: number; maxPence: number };
  items: PlanItem[];
}

export type PlanSummary = Omit<Plan, 'items'>;

export interface PlanAllowance {
  mode: 'warn' | 'enforce';
  limit: number | null;
  used: number;
  credits: number;
  remaining: number | null;
}

export interface PlanCost {
  capPence: number | null;
  spentPence: number;
  creditHeadroomPence: number;
}

export interface PlanDefaults {
  timezone: string;
  startDate: string;
  days: number;
  maxDays: number;
  postsPerDay: number;
  maxPostsPerDay: number;
  hasPostingTimes: boolean;
  postingTimesPerWeek: number;
  videoShare: number;
  planTier: string;
  allowance: PlanAllowance;
  cost: PlanCost;
  typicalCostPence: Record<ItemKind, number>;
}

/** Items the plan still counts (removed and skipped ones are shown but not counted). */
export function liveItems(items: readonly PlanItem[]): PlanItem[] {
  return items.filter((i) => i.status !== 'REMOVED' && i.status !== 'SKIPPED');
}

/** The local day (YYYY-MM-DD) of an instant in the plan's time zone. */
export function dayOf(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(iso));
}

/** Items grouped by local day, days and items in time order. */
export function groupByDay(
  items: readonly PlanItem[],
  timezone: string,
): Array<{ day: string; items: PlanItem[] }> {
  const map = new Map<string, PlanItem[]>();
  for (const item of [...items].sort((a, b) => a.slotAt.localeCompare(b.slotAt))) {
    const day = dayOf(item.slotAt, timezone);
    map.set(day, [...(map.get(day) ?? []), item]);
  }
  return [...map.entries()].map(([day, list]) => ({ day, items: list }));
}

export function kindCounts(items: readonly PlanItem[]): Record<ItemKind, number> {
  return {
    VIDEO: items.filter((i) => i.kind === 'VIDEO').length,
    SLIDESHOW: items.filter((i) => i.kind === 'SLIDESHOW').length,
  };
}

/** How many topics Claude has written so far (drafting progress). */
export function writtenCount(items: readonly PlanItem[]): number {
  return items.filter((i) => i.title.trim().length > 0).length;
}

/** Statuses the owner can still remove or swap before the post time. */
const OPEN_STATUSES: ReadonlySet<ItemStatus> = new Set([
  'QUEUED',
  'GENERATING',
  'READY',
  'SCHEDULED',
  'HELD',
  'FAILED',
]);

export function canChangeScheduled(item: PlanItem, now: number): boolean {
  return OPEN_STATUSES.has(item.status) && Date.parse(item.slotAt) > now;
}

export function isPlanActive(status: PlanStatus): boolean {
  return status === 'DRAFTING' || status === 'GENERATING';
}

/** Posts the form's choices would ask for (before free times and the allowance). */
export function requestedPosts(days: number, postsPerDay: number): number {
  return Math.max(0, Math.round(days)) * Math.max(0, Math.round(postsPerDay));
}

/** Swap two neighbouring draft items (for "Move up / Move down"); the API reorders topics. */
export function moveItem(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/** Slide points edited as one line each. */
export function pointsFromText(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((l) => l.slice(0, 100));
}

export type PlanProblem = 'platformRequired' | 'accountRequired' | 'daysRange' | 'startRequired';

export interface PlanFormState {
  startDate: string;
  days: number;
  postsPerDay: number;
  useDripSlots: boolean;
  videoShare: number;
  platforms: string[];
  accounts: Record<string, string>;
}

/**
 * `withAccounts` (20.12): the chosen platforms this business has a connected account for. Each
 * of those needs its account chosen; a platform without one is still made but not posted, and a
 * plan with no account at all is made and saved for review (never blocked).
 */
export function validatePlanForm(
  state: PlanFormState,
  maxDays = 31,
  withAccounts: readonly string[] = state.platforms,
): PlanProblem[] {
  const problems: PlanProblem[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(state.startDate)) problems.push('startRequired');
  if (!Number.isInteger(state.days) || state.days < 1 || state.days > maxDays)
    problems.push('daysRange');
  if (state.platforms.length === 0) problems.push('platformRequired');
  else if (state.platforms.some((p) => withAccounts.includes(p) && !state.accounts[p]))
    problems.push('accountRequired');
  return problems;
}

/** The POST /content-plans body. */
export function buildPlanBody(state: PlanFormState, businessId: string, timezone: string) {
  return {
    businessId,
    startDate: state.startDate,
    days: state.days,
    ...(state.useDripSlots ? { useDripSlots: true } : { postsPerDay: state.postsPerDay }),
    videoShare: state.videoShare,
    platforms: state.platforms,
    // 20.12: only platforms with a chosen account; none = the posts are saved for review.
    targets: state.platforms.flatMap((platform) =>
      state.accounts[platform] ? [{ platform, connectionId: state.accounts[platform] }] : [],
    ),
    timezone,
  };
}
