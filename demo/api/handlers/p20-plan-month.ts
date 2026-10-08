// Phase 20.9 sample state — "Plan my month". The same envelopes and shapes as the real routes
// (src/app/api/studio/content-plans/**), with the real slot maths and mix (content-plans/slots.ts,
// mix.ts, calendar-days.ts):
//   GET    /content-plans/defaults                next free day, posting times, allowance, cost
//   GET    /content-plans                         the business's plans
//   POST   /content-plans                         lay out and cap the month; "Claude" drafts it
//                                                 over the next few reads (DRAFTING → DRAFT)
//   GET    /content-plans/:id                     the plan; generating items move on each read
//   POST   /content-plans/:id/generate            one project per post, scheduled at its time
//   POST   /content-plans/:id/cancel | redraft | reorder | items
//   PATCH  /content-plans/:id/items/:itemId       edit a draft post, or swap a scheduled one
//   DELETE /content-plans/:id/items/:itemId       delete a draft post, or remove a scheduled one
//   POST   /content-plans/:id/items/:itemId/regenerate
// A seeded October plan is half made: some posts scheduled (on the calendar as publications),
// some still being made (dashed "Planned" markers), one held by the safety check.
import {
  CALENDAR_DAY_NAMES,
  calendarDaysBetween,
  type CalendarDayId,
} from '@/lib/studio/content-plans/calendar-days';
import { buildSkeleton, type PlanKind } from '@/lib/studio/content-plans/mix';
import {
  availableSlots,
  dailySlots,
  defaultStartDate,
  formatLocalDate,
  parseLocalDate,
  planWindow,
} from '@/lib/studio/content-plans/slots';
import { presetSlots } from '@/lib/studio/drip-presets';
import { upcomingSlots } from '@/lib/studio/services/drip-queue';
import { billingOverview, internalCostThisMonth, videoQuota } from '../billing-state';
import { CONNECTIONS, DEMO_BUSINESS_ID } from '../ids';
import { demoHashtags } from '../hashtags-data';
import { DemoHttpError, route } from '../registry';
import type { PublicationCampaign } from '@/lib/client/types';
import type { ProjectContent } from './projects-content';
import {
  baseProject,
  buildRender,
  buildScripts,
  fmt,
  HOUR,
  nowIso,
  putProject,
} from './projects-store';
import { addPublication, listPublications, updatePublication } from './publications-store';

const ZONE = 'Europe/London';
const STATUSES = [
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
] as const;
type ItemStatus = (typeof STATUSES)[number];

interface DemoItem {
  id: string;
  position: number;
  slotAt: string;
  kind: PlanKind;
  angle: string;
  title: string;
  brief: string;
  slides: { hook: string; points: string[]; cta: string } | null;
  calendarDay: string | null;
  status: ItemStatus;
  statusReason: string | null;
  projectId: string | null;
  /** 20.13: the owner's caption + hashtags per platform (otherwise drafted below). */
  postCopy?: Record<string, { caption: string; hashtags: string[] }>;
}

interface DemoPlan {
  id: string;
  businessId: string;
  status: 'DRAFTING' | 'DRAFT' | 'GENERATING' | 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
  startDate: string;
  days: number;
  postsPerDay: number;
  useDripSlots: boolean;
  videoShare: number;
  platforms: string[];
  /** 20.12: platforms with an account; undefined = every platform (the seeded plans). */
  targetPlatforms?: string[];
  requestedCount: number;
  cappedReason: 'allowance' | 'cost_cap' | null;
  holdReason: null;
  draftError: null;
  createdAt: string;
  scheduledAt: string | null;
  cancelledAt: string | null;
  items: DemoItem[];
  /** Reads left before the next simulated step (drafting / generating). */
  reads: number;
  /**
   * 23.6: the seeded plan shows rolling generation (later posts wait for their creation time);
   * plans made in the demo fast-forward so they finish within a few reads.
   */
  rolling?: boolean;
}

const bad = (message: string) => new DemoHttpError(400, 'validation_error', message);
const conflict = (message: string) => new DemoHttpError(409, 'conflict', message);
const plans = new Map<string, DemoPlan>();
let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}`;

// ------------------------------------------------------------------ what "Claude" writes

const TOPICS: Record<string, Array<[string, string]>> = {
  how_to: [
    [
      'How to keep sourdough fresh for a week',
      'Show the linen bag, the bread bin and the freezer trick; end on “order your weekly loaf”.',
    ],
    [
      'Slice a crusty loaf without squashing it',
      'A bread knife, a sawing motion, the loaf on its side. Close on the subscription.',
    ],
    ['Revive a day-old loaf in five minutes', 'Splash of water, hot oven, crackling crust again.'],
    [
      'What “levain” actually means',
      'The starter, the feed, the bubbles — a quick explainer from the bench.',
    ],
  ],
  product_feature: [
    [
      'The seeded rye everyone asks about',
      'Close-ups of the crumb and the seeds; available in the weekly box.',
    ],
    ['Our weekly bread subscription, explained', 'What arrives, when, and how to pause a week.'],
    ['The spelt loaf for a lighter crumb', 'Spelt flour, longer prove, softer bite.'],
    ['Focaccia Fridays', 'Rosemary, sea salt, olive oil; Fridays only.'],
  ],
  behind_the_scenes: [
    ['5am at the bakery', 'Ovens on, dough out, the team in aprons — what dawn looks like here.'],
    ['Feeding the 12-year-old starter', 'Meet the starter that started it all.'],
    ['Shaping 200 loaves before sunrise', 'Hands, bench flour, the rhythm of shaping.'],
    ['Where our flour comes from', 'The Yorkshire mill we buy from, and why it matters.'],
  ],
  offer: [
    ['Try the weekly box', 'Invite people to start a weekly bread box; no prices or discounts.'],
    ['Book a Saturday sourdough class', 'Hands-on class at the bakery; book online.'],
    ['Order a loaf for Sunday lunch', 'Pre-order by Friday, collect Saturday.'],
    ['Wholesale for local cafés', 'Fresh bread delivered to cafés in north Leeds.'],
  ],
  testimonial: [
    [
      'Why regulars come back every Saturday',
      'The crust, the queue chat, the smell — told from what we do, no quotes.',
    ],
    ['What makes a loaf worth the walk', 'Long ferment, local flour, baked that morning.'],
    ['Why cafés choose our bread', 'Consistency, early delivery, bread that lasts the day.'],
    ['The loaf people buy two of', 'Our best seller and what makes it keep.'],
  ],
  seasonal: [['Seasonal bake', 'A seasonal twist on the weekly loaf for the day.']],
  custom: [['Your idea', 'Tell us what this post is about.']],
};
const turns = new Map<string, number>();

function topicFor(angle: string, calendarDay: string | null): { title: string; brief: string } {
  if (angle === 'seasonal' && calendarDay) {
    const name = CALENDAR_DAY_NAMES[calendarDay as CalendarDayId] ?? calendarDay;
    return {
      title: `${name} at the bakery`,
      brief: `Tie the week's special loaf to ${name}; show it on the counter; order the day before.`,
    };
  }
  const bank = TOPICS[angle] ?? TOPICS.how_to!;
  const n = turns.get(angle) ?? 0;
  turns.set(angle, n + 1);
  const [title, brief] = bank[n % bank.length]!;
  return { title, brief };
}

const slidesFor = (title: string) => ({
  hook: title,
  points: ['Baked at dawn', 'Local Yorkshire flour', 'Delivered every week'],
  cta: 'Order your loaf',
});

function write(item: DemoItem): void {
  const topic = topicFor(item.angle, item.calendarDay);
  item.title = topic.title;
  item.brief = topic.brief;
  item.slides = slidesFor(topic.title);
}

// ------------------------------------------------------------------ public shapes

function counts(items: DemoItem[]): Record<ItemStatus, number> {
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<ItemStatus, number>;
  for (const i of items) out[i.status] += 1;
  return out;
}

const live = (items: DemoItem[]) =>
  items.filter((i) => i.status !== 'REMOVED' && i.status !== 'SKIPPED');

/** 23.6 rolling generation: a queued post is only made in the 72 hours before its slot. */
const CREATE_LEAD_MS = 72 * HOUR;

function createsAt(plan: DemoPlan, item: DemoItem, now = Date.now()): string | null {
  if (!plan.rolling || item.status !== 'QUEUED') return null;
  const at = Date.parse(item.slotAt) - CREATE_LEAD_MS;
  return at > now ? new Date(at).toISOString() : null;
}

function publicPlan(p: DemoPlan) {
  const window = planWindow(parseLocalDate(p.startDate), p.days, ZONE);
  const kinds = live(p.items).map((i) => i.kind);
  const videos = kinds.filter((k) => k === 'VIDEO').length;
  return {
    id: p.id,
    businessId: p.businessId,
    status: p.status,
    startDate: p.startDate,
    days: p.days,
    timezone: ZONE,
    windowStart: new Date(window.windowStart).toISOString(),
    windowEnd: new Date(window.windowEnd).toISOString(),
    postsPerDay: p.postsPerDay,
    useDripSlots: p.useDripSlots,
    videoShare: p.videoShare,
    platforms: p.platforms,
    targets: (p.targetPlatforms ?? p.platforms).map((platform) => ({
      platform,
      connectionId: CONNECTIONS.tiktok.id,
      platformAccountId: null,
    })),
    language: 'en-GB',
    brandKitId: null,
    requestedCount: p.requestedCount,
    cappedReason: p.cappedReason,
    holdReason: p.holdReason,
    draftError: p.draftError,
    createdAt: p.createdAt,
    generationStartedAt: null,
    scheduledAt: p.scheduledAt,
    completedAt: null,
    cancelledAt: p.cancelledAt,
    counts: counts(p.items),
    estimate: {
      typicalPence: videos * 160 + (kinds.length - videos) * 150,
      maxPence: videos * 350 + (kinds.length - videos) * 150,
    },
    items: [...p.items]
      .sort((a, b) => a.slotAt.localeCompare(b.slotAt))
      .map((i) => ({
        ...i,
        postCopy: i.title ? itemCopy(i, p.platforms) : null,
        createsAt: createsAt(p, i),
      })),
  };
}

function allowance() {
  const { short } = videoQuota();
  const credits = billingOverview(1).credits.short;
  const remaining = short.limit === null ? null : Math.max(0, short.limit - short.used) + credits;
  return { mode: 'enforce' as const, limit: short.limit, used: short.used, credits, remaining };
}

/** The plan's internal cost figures (the real API sends them; customer screens never show them). */
function cost() {
  const { capPence, spentPence } = internalCostThisMonth();
  return { capPence, spentPence, creditHeadroomPence: 250 };
}

// ------------------------------------------------------------------ simulation

const PLAN_CONTENT = (title: string, brief: string): ProjectContent => ({
  scene: 'sourdough',
  brief: {
    hook: title,
    keyMessage: brief,
    targetAudience: 'Weekend regulars in north Leeds',
    tone: 'Warm, crafted',
  },
  shots: [
    {
      treatment: 'AI_CLIP',
      durationSec: 5,
      kind: 'sourdough',
      scene: 'A crusty loaf on a floured board.',
      camera: 'slow push-in',
      voiceover: title,
      onScreen: title,
    },
    {
      treatment: 'AI_CLIP',
      durationSec: 6,
      kind: 'baker',
      scene: 'Hands shaping dough at dawn.',
      camera: 'handheld',
      voiceover: brief,
      onScreen: null,
    },
    {
      treatment: 'TEXT_CARD',
      durationSec: 4,
      kind: 'logo',
      scene: 'End card.',
      camera: null,
      voiceover: 'Order your loaf.',
      onScreen: 'Order your loaf',
    },
  ],
});

/** Make the item's project (approved, scheduled at its time) and its calendar publication. */
function schedule(plan: DemoPlan, item: DemoItem): void {
  const id = item.projectId ?? nextId('prj-plan');
  const p = baseProject(id, item.title, {
    state: 'APPROVED',
    scene: 'sourdough',
    sourceType: item.kind === 'SLIDESHOW' ? 'SLIDESHOW' : 'BRIEF',
    description: item.brief,
    targetFormats: [fmt('tiktok', '9:16', 15)],
    reviewPolicy: 'AUTO_APPROVE',
    publishPolicy: 'SCHEDULED',
    costActualPence: item.kind === 'VIDEO' ? 142 : 38,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completedAt: nowIso(),
    metadata: {
      contentPlan: { planId: plan.id, itemId: item.id, preApproved: true },
      review: { decision: 'auto_approved', at: nowIso() },
      autoPublish: { targets: [{ platform: 'tiktok', connectionId: CONNECTIONS.tiktok.id }] },
    },
  });
  const content = PLAN_CONTENT(item.title, item.brief);
  p.brief = content.brief;
  p.scripts = buildScripts(id, p.targetFormats, content);
  p.renders = p.scripts.map((s) => buildRender(p, s, { id: `rnd-${id}-${s.targetPlatform}` }));
  putProject(p);
  item.projectId = id;
  addPublication({
    id: `pub-${id}`,
    projectId: id,
    renderId: p.renders[0]?.id ?? `rnd-${id}`,
    platform: 'tiktok',
    platformAccountId: CONNECTIONS.tiktok.accountId,
    state: 'SCHEDULED',
    scheduledFor: item.slotAt,
    publishedAt: null,
    platformPostId: null,
    platformUrl: null,
    caption: item.title,
    hashtags: ['leeds', 'sourdough'],
    errorReason: null,
    errorCode: null,
    retryCount: 0,
    createdAt: nowIso(),
    project: { id, name: item.title },
  });
  item.status = 'SCHEDULED';
}

/** One step per read, so the screens show progress without timers. */
function advance(plan: DemoPlan): void {
  if (plan.reads > 0) {
    plan.reads -= 1;
    return;
  }
  if (plan.status === 'DRAFTING') {
    const blank = plan.items.filter((i) => !i.title);
    for (const item of blank.slice(0, Math.ceil(plan.items.length / 2))) write(item);
    if (plan.items.every((i) => i.title)) plan.status = 'DRAFT';
    return;
  }
  if (plan.status !== 'GENERATING') return;
  for (const item of plan.items.filter((i) => i.status === 'GENERATING').slice(0, 2))
    schedule(plan, item);
  const due = plan.items.filter((i) => i.status === 'QUEUED' && createsAt(plan, i) === null);
  for (const item of due.slice(0, 2)) item.status = 'GENERATING';
  if (plan.items.every((i) => !['QUEUED', 'GENERATING'].includes(i.status))) {
    plan.status = 'SCHEDULED';
    plan.scheduledAt = nowIso();
  }
}

// ------------------------------------------------------------------ the seeded October plan

function seed(): void {
  const now = Date.now();
  const start = defaultStartDate(now, ZONE);
  const slots = dailySlots(start, 14, 1, ZONE);
  const skeleton = buildSkeleton({
    slots,
    videoShare: 50,
    calendarDays: calendarDaysBetween(start, 14),
    timezone: ZONE,
  });
  const plan: DemoPlan = {
    id: 'plan-october',
    businessId: DEMO_BUSINESS_ID,
    status: 'GENERATING',
    startDate: formatLocalDate(start),
    days: 14,
    postsPerDay: 1,
    useDripSlots: false,
    videoShare: 50,
    platforms: ['tiktok'],
    requestedCount: skeleton.length,
    cappedReason: null,
    holdReason: null,
    draftError: null,
    createdAt: new Date(now - 2 * HOUR).toISOString(),
    scheduledAt: null,
    cancelledAt: null,
    items: [],
    reads: 2,
    rolling: true,
  };
  plan.items = skeleton.map((s, position) => {
    const item: DemoItem = {
      id: `item-october-${position}`,
      position,
      slotAt: new Date(s.slotAt).toISOString(),
      kind: s.kind,
      angle: s.angle,
      title: '',
      brief: '',
      slides: null,
      calendarDay: s.calendarDay,
      status: 'QUEUED',
      statusReason: null,
      projectId: null,
    };
    write(item);
    return item;
  });
  plan.items.slice(0, 7).forEach((item) => schedule(plan, item));
  const held = plan.items[7];
  if (held) {
    held.status = 'HELD';
    held.statusReason = 'content_safety_flag';
  }
  for (const item of plan.items.slice(8, 10)) item.status = 'GENERATING';
  plans.set(plan.id, plan);
}

seed();

/** 20.9: month-plan posts still being made, for the calendar (GET …/drip-queue/upcoming). */
export function demoPlannedPosts(window: { fromMs: number; toMs: number }) {
  return [...plans.values()]
    .filter((p) => p.status === 'GENERATING' || p.status === 'SCHEDULED')
    .flatMap((p) =>
      p.items
        .filter(
          (i) =>
            ['QUEUED', 'GENERATING', 'READY', 'HELD'].includes(i.status) &&
            Date.parse(i.slotAt) >= window.fromMs &&
            Date.parse(i.slotAt) < window.toMs,
        )
        .map((i) => ({
          slotAt: i.slotAt,
          planId: p.id,
          itemId: i.id,
          title: i.title,
          kind: i.kind,
          status: i.status,
          // 25.9: a hand-made month plan, not an automation period (the calendar's source filter).
          automationId: null,
        })),
    );
}

/** 25.9: the sample month plan as a calendar post's campaign (GET /publications `campaign`). */
export function demoPlanCampaign(): PublicationCampaign | null {
  const plan = plans.get('plan-october');
  return plan
    ? { kind: 'plan', planId: plan.id, startDate: plan.startDate, days: plan.days }
    : null;
}

/** 20.9: every time an active plan holds (the drip queue never offers them). */
export function demoPlanHeld(): Date[] {
  return [...plans.values()]
    .filter((p) => p.status === 'GENERATING' || p.status === 'SCHEDULED')
    .flatMap((p) =>
      p.items
        .filter((i) => ['QUEUED', 'GENERATING', 'READY', 'SCHEDULED', 'HELD'].includes(i.status))
        .map((i) => new Date(i.slotAt)),
    );
}

// ------------------------------------------------------------------ routes

/** The next free day: after the latest active plan (like services/content-plans.ts). */
function nextFreeStart(now: number) {
  const ends = [...plans.values()]
    .filter((p) => ['DRAFT', 'GENERATING', 'SCHEDULED'].includes(p.status))
    .map((p) => planWindow(parseLocalDate(p.startDate), p.days, ZONE).windowEnd);
  return defaultStartDate(now, ZONE, ends.length ? Math.max(...ends) : undefined);
}

function planOr404(id: string | undefined): DemoPlan {
  const plan = plans.get(id ?? '');
  if (!plan) throw new DemoHttpError(404, 'not_found', 'Plan not found');
  return plan;
}

function itemOr404(plan: DemoPlan, id: string | undefined): DemoItem {
  const item = plan.items.find((i) => i.id === id);
  if (!item) throw new DemoHttpError(404, 'not_found', 'Plan item not found');
  return item;
}

route('GET', '/content-plans/defaults', () => {
  const start = nextFreeStart(Date.now());
  return {
    defaults: {
      timezone: ZONE,
      startDate: formatLocalDate(start),
      days: 30,
      maxDays: 31,
      postsPerDay: 1,
      maxPostsPerDay: 4,
      hasPostingTimes: true,
      postingTimesPerWeek: 3,
      videoShare: 50,
      planTier: 'STANDARD',
      allowance: allowance(),
      cost: cost(),
      typicalCostPence: { VIDEO: 160, SLIDESHOW: 150 },
    },
  };
});

route('GET', '/content-plans', () => ({
  data: [...plans.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((p) => {
      const { items: _items, ...summary } = publicPlan(p);
      void _items;
      return summary;
    }),
}));

route('POST', '/content-plans', ({ body }) => {
  const input = (body ?? {}) as Record<string, unknown>;
  const days = Number(input.days ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 31) throw bad('days: between 1 and 31');
  const platforms = Array.isArray(input.platforms) ? (input.platforms as string[]) : [];
  const targets = Array.isArray(input.targets)
    ? (input.targets as Array<{ platform: string }>)
    : [];
  if (platforms.length === 0) throw bad('platforms: choose at least one');
  // 20.12: platforms without an account are made but not posted; none = saved for review.
  const targetPlatforms = platforms.filter((p) => targets.some((t) => t.platform === p));
  const now = Date.now();
  const start =
    typeof input.startDate === 'string' ? parseLocalDate(input.startDate) : nextFreeStart(now);
  const useDripSlots = input.useDripSlots === true;
  const postsPerDay = useDripSlots ? 1 : Math.min(4, Math.max(1, Number(input.postsPerDay ?? 1)));
  const window = planWindow(start, days, ZONE);
  const candidates = useDripSlots
    ? upcomingSlots(presetSlots('three', ZONE), window.windowStart - 1, days + 1).filter(
        (at) => at < window.windowEnd,
      )
    : dailySlots(start, days, postsPerDay, ZONE);
  const slots = availableSlots(candidates, demoPlanHeld(), now);
  if (slots.length === 0) throw bad('There are no free posting times left in this window');
  const videoShare = Math.min(100, Math.max(0, Number(input.videoShare ?? 50)));
  const skeleton = buildSkeleton({
    slots,
    videoShare,
    calendarDays: calendarDaysBetween(start, days),
    timezone: ZONE,
  });
  const left = allowance().remaining;
  const count = left === null ? skeleton.length : Math.min(left, skeleton.length);
  if (count === 0)
    throw new DemoHttpError(
      403,
      'quota_exceeded',
      'Your plan has no videos left this month; buy a video pack to plan your month',
    );
  const plan: DemoPlan = {
    id: nextId('plan'),
    businessId: String(input.businessId ?? DEMO_BUSINESS_ID),
    status: 'DRAFTING',
    startDate: formatLocalDate(start),
    days,
    postsPerDay,
    useDripSlots,
    videoShare,
    platforms,
    targetPlatforms,
    requestedCount: skeleton.length,
    cappedReason: count < skeleton.length ? 'allowance' : null,
    holdReason: null,
    draftError: null,
    createdAt: nowIso(),
    scheduledAt: null,
    cancelledAt: null,
    reads: 1,
    items: skeleton.slice(0, count).map((s, position) => ({
      id: nextId('item'),
      position,
      slotAt: new Date(s.slotAt).toISOString(),
      kind: s.kind,
      angle: s.angle,
      title: '',
      brief: '',
      slides: null,
      calendarDay: s.calendarDay,
      status: 'PLANNED' as const,
      statusReason: null,
      projectId: null,
    })),
  };
  plans.set(plan.id, plan);
  return {
    status: 202,
    body: { plan: publicPlan(plan), allowance: allowance(), cost: cost() },
  };
});

/** 20.13: a planned post's caption and hashtags per platform (drafted with the topic). */
function itemCopy(item: DemoItem, platforms: string[]) {
  const drafted = [item.slides?.hook ?? item.title, item.slides?.cta]
    .filter(Boolean)
    .join(String.fromCharCode(10));
  return Object.fromEntries(
    platforms.map((p) => {
      const own = item.postCopy?.[p];
      return [
        p,
        own ?? { caption: drafted, hashtags: demoHashtags(['Sourdough', 'LeedsFood', 'Bake'], p) },
      ];
    }),
  );
}

route('PUT', '/content-plans/:id/items/:itemId/post-copy', ({ params, body }) => {
  const plan = planOr404(params.id);
  const item = plan.items.find((i) => i.id === params.itemId);
  if (!item) throw new DemoHttpError(404, 'not_found', 'Plan item not found');
  const b = (body ?? {}) as { platform?: string; caption?: string; hashtags?: unknown };
  const chosen = (Array.isArray(b.hashtags) ? b.hashtags : []).filter(
    (t): t is string => typeof t === 'string',
  );
  // The editor sends the business and always hashtags with the owner's own (as the real route).
  if (chosen.length < 5)
    throw new DemoHttpError(400, 'validation_error', 'Posts need at least 5 hashtags', {
      code: 'hashtags_minimum',
    });
  item.postCopy = {
    ...(item.postCopy ?? {}),
    [b.platform ?? 'tiktok']: { caption: (b.caption ?? '').trim(), hashtags: chosen },
  };
  return {
    plan: publicPlan(plan),
    copy: { caption: b.caption ?? '', hashtags: chosen },
    scheduledUpdated: 0,
  };
});

route('GET', '/content-plans/:id', ({ params }) => {
  const plan = planOr404(params.id);
  advance(plan);
  return { plan: publicPlan(plan) };
});

route('POST', '/content-plans/:id/redraft', ({ params }) => {
  const plan = planOr404(params.id);
  if (plan.status !== 'DRAFT') throw conflict(`The plan is ${plan.status}`);
  plan.status = 'DRAFTING';
  return { status: 202, body: { plan: publicPlan(plan) } };
});

route('POST', '/content-plans/:id/generate', ({ params }) => {
  const plan = planOr404(params.id);
  if (plan.status !== 'DRAFT') throw conflict(`The plan is ${plan.status}`);
  for (const item of plan.items) if (item.status === 'PLANNED') item.status = 'QUEUED';
  plan.status = 'GENERATING';
  plan.reads = 1;
  return { status: 202, body: { plan: publicPlan(plan) } };
});

route('POST', '/content-plans/:id/cancel', ({ params }) => {
  const plan = planOr404(params.id);
  if (plan.status === 'CANCELLED' || plan.status === 'COMPLETED')
    throw conflict(`The plan is ${plan.status}`);
  for (const item of plan.items) {
    if (['POSTED', 'REMOVED', 'SKIPPED'].includes(item.status)) continue;
    if (item.projectId) updatePublication(`pub-${item.projectId}`, { state: 'CANCELLED' });
    item.status = 'REMOVED';
    item.statusReason = 'plan_cancelled';
  }
  plan.status = 'CANCELLED';
  plan.cancelledAt = nowIso();
  return { plan: publicPlan(plan), keptPublishing: 0 };
});

route('POST', '/content-plans/:id/reorder', ({ params, body }) => {
  const plan = planOr404(params.id);
  if (plan.status !== 'DRAFT') throw conflict('Only a draft can be reordered');
  const ids = ((body ?? {}) as { itemIds?: string[] }).itemIds ?? [];
  const planned = plan.items.filter((i) => i.status === 'PLANNED');
  if (ids.length !== planned.length || planned.some((i) => !ids.includes(i.id)))
    throw bad('itemIds must list every item of the draft exactly once');
  const times = planned.map((i) => i.slotAt).sort();
  ids.forEach((id, n) => {
    const item = itemOr404(plan, id);
    item.slotAt = times[n]!;
    item.position = n;
  });
  return { plan: publicPlan(plan) };
});

route('POST', '/content-plans/:id/items', ({ params, body }) => {
  const plan = planOr404(params.id);
  if (plan.status !== 'DRAFT') throw conflict('Posts can only be added to a draft');
  const input = (body ?? {}) as Partial<DemoItem> & { slotAt?: string };
  const at = Date.parse(input.slotAt ?? '');
  const window = planWindow(parseLocalDate(plan.startDate), plan.days, ZONE);
  if (!(at >= window.windowStart && at < window.windowEnd))
    throw bad('The time must be inside the plan’s dates');
  if (!input.title || !input.brief) throw bad('title and brief are required');
  plan.items.push({
    id: nextId('item'),
    position: plan.items.length,
    slotAt: new Date(at).toISOString(),
    kind: input.kind === 'SLIDESHOW' ? 'SLIDESHOW' : 'VIDEO',
    angle: 'custom',
    title: input.title,
    brief: input.brief,
    slides: input.slides ?? slidesFor(input.title),
    calendarDay: null,
    status: 'PLANNED',
    statusReason: null,
    projectId: null,
  });
  return { status: 201, body: { plan: publicPlan(plan) } };
});

route('PATCH', '/content-plans/:id/items/:itemId', ({ params, body }) => {
  const plan = planOr404(params.id);
  const item = itemOr404(plan, params.itemId);
  const input = (body ?? {}) as Partial<DemoItem>;
  if (['POSTED', 'REMOVED', 'SKIPPED'].includes(item.status))
    throw conflict(`This post is ${item.status.toLowerCase()}`);
  if (input.title !== undefined) item.title = input.title;
  if (input.brief !== undefined) item.brief = input.brief;
  if (input.kind !== undefined) item.kind = input.kind;
  if (input.slides !== undefined) item.slides = input.slides;
  if (plan.status !== 'DRAFT') {
    // A swap: the old post comes off the calendar and the new one is made at the same time.
    if (item.projectId) updatePublication(`pub-${item.projectId}`, { state: 'CANCELLED' });
    item.projectId = null;
    item.status = 'QUEUED';
    item.statusReason = null;
    plan.status = 'GENERATING';
    plan.reads = 1;
  }
  return { plan: publicPlan(plan) };
});

route('DELETE', '/content-plans/:id/items/:itemId', ({ params }) => {
  const plan = planOr404(params.id);
  const item = itemOr404(plan, params.itemId);
  if (plan.status === 'DRAFT') {
    plan.items = plan.items.filter((i) => i.id !== item.id);
    return { plan: publicPlan(plan) };
  }
  if (['POSTED', 'REMOVED', 'SKIPPED'].includes(item.status))
    throw conflict(`This post is ${item.status.toLowerCase()}`);
  if (item.projectId) updatePublication(`pub-${item.projectId}`, { state: 'CANCELLED' });
  item.status = 'REMOVED';
  item.statusReason = 'removed_by_owner';
  return { plan: publicPlan(plan) };
});

route('POST', '/content-plans/:id/items/:itemId/regenerate', ({ params }) => {
  const plan = planOr404(params.id);
  if (plan.status !== 'DRAFT') throw conflict('Only draft posts get a new topic');
  const item = itemOr404(plan, params.itemId);
  const angle = item.angle === 'seasonal' ? 'how_to' : item.angle;
  const topic = topicFor(angle, null);
  item.title = topic.title;
  item.brief = topic.brief;
  item.slides = slidesFor(topic.title);
  return { plan: publicPlan(plan) };
});

/** Scheduled publications of plan posts (for tests and the tour). */
export function demoPlanPublications() {
  const ids = new Set(
    [...plans.values()].flatMap((p) => p.items.map((i) => i.projectId).filter(Boolean)),
  );
  return listPublications().filter((pub) => ids.has(pub.projectId));
}
