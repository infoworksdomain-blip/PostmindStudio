// Phase 22.4 / 22.5 sample state — Blitz (swipe review) and Automations, with the same envelopes
// as the real routes (services/blitz.ts, services/automations.ts, services/automation-actions.ts):
//   GET  /blitz?businessId=                        the deck (carousel, slideshow, preview cards)
//   POST /blitz/refill                             a fresh deck ("Generate more")
//   POST /blitz/suggestions/:id/decision           keep (schedule | post_now | edit) / skip (+ reason)
//   GET/POST /businesses/:id/angles, PATCH …/:angleId, POST …/suggest
//   GET/PUT  /businesses/:id/content-mix
//   GET/POST /automations, POST /automations/estimate, GET /automations/:id,
//   POST /automations/:id/:action, POST /automations/:id/slots/:itemId
// Nothing here renders or posts: the cards use the demo's sample pictures and video.
import { sampleVideo, sceneImage, type SceneKind } from '../../media';
import { DemoHttpError, route } from '../registry';
import { PROJECTS } from '../ids';

type Format = 'carousel' | 'slideshow' | 'ai_video' | 'ugc';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface DemoAngle {
  id: string;
  title: string;
  description: string;
  targetAudience: string;
  weight: number;
  source: 'owner' | 'ai';
  retired: boolean;
}

const angles: DemoAngle[] = [
  {
    id: 'ang-weekend',
    title: 'Weekend bakes',
    description: 'Ideas for a slow Saturday morning',
    targetAudience: 'families in Leeds',
    weight: 60,
    source: 'owner',
    retired: false,
  },
  {
    id: 'ang-starter',
    title: 'Starter care',
    description: 'Keeping a sourdough starter alive',
    targetAudience: 'home bakers',
    weight: 40,
    source: 'ai',
    retired: false,
  },
  {
    id: 'ang-behind',
    title: 'Behind the counter',
    description: 'How the bakery works at 4 am',
    targetAudience: 'locals',
    weight: 50,
    source: 'owner',
    retired: false,
  },
];

const mix = {
  formatWeights: { carousel: 35, slideshow: 35, ai_video: 0, ugc: 0 } as Record<Format, number>,
  remixPercent: 20,
  mentionBusinessPercent: 30,
  adjustments: {
    formats: {} as Record<string, number>,
    angles: {} as Record<string, number>,
    mention: 0,
  },
};

const slides = (kinds: SceneKind[]) => kinds.map((k) => sceneImage(k, 540, 675));

function card(
  id: string,
  format: Format,
  angle: DemoAngle,
  copy: { title: string; hook: string; body: string[]; cta: string; why: string },
  extra: Record<string, unknown> = {},
) {
  const preview = format === 'ai_video' || format === 'ugc';
  return {
    id,
    format,
    tier: preview ? 'preview' : 'premade',
    angle: { id: angle.id, title: angle.title },
    title: copy.title,
    hook: copy.hook,
    body: copy.body,
    cta: copy.cta,
    hookType: 'call_out',
    caption: copy.hook,
    whyItWorks: copy.why,
    mentionBusiness: false,
    slides: [] as string[],
    videoUrl: null as string | null,
    posterUrl: null as string | null,
    previewImageUrl: preview ? sceneImage('flatlay', 540, 960) : null,
    remix: null as unknown,
    allowanceUnits: format === 'ugc' ? 2 : 1,
    createdAt: new Date(Date.now() - HOUR).toISOString(),
    ...extra,
  };
}

type Card = ReturnType<typeof card>;

async function freshDeck(): Promise<Card[]> {
  const [a, b, c] = angles as [DemoAngle, DemoAngle, DemoAngle];
  return [
    card(
      'sug-flat-loaf',
      'carousel',
      b,
      {
        title: '3 reasons your sourdough is flat',
        hook: 'Flat sourdough? It is usually one of these three.',
        body: ['Your starter is tired', 'The dough was under-proved', 'Too much water too soon'],
        cta: 'Grab a loaf from us this week',
        why: 'A mistake hook names a problem every home baker has, then fixes it in three slides.',
      },
      {
        slides: slides(['sourdough', 'flatlay', 'baker', 'croissant', 'storefront']),
        remix: {
          id: 'lib-question-hook',
          title: 'Question hook + 3-step listicle (reference)',
          thumbnailUrl: sceneImage('coffee', 360, 640),
          durationSec: 18,
        },
      },
    ),
    card(
      'sug-saturday',
      'slideshow',
      a,
      {
        title: 'Your slow Saturday, sorted',
        hook: 'Families in Leeds: this is your Saturday plan.',
        body: ['Warm croissants by nine', 'Coffee for the grown-ups', 'Bread for the week'],
        cta: 'Open from 7 am',
        why: 'A call-out hook speaks to families in the first second; photo slides keep it light.',
      },
      {
        videoUrl: await sampleVideo({
          scene: 'croissant',
          aspect: '9:16',
          seconds: 6,
          caption: 'Your slow Saturday, sorted',
        }).catch(() => null),
        posterUrl: sceneImage('croissant', 540, 960),
      },
    ),
    card('sug-4am', 'ai_video', c, {
      title: 'What 4 am looks like in a bakery',
      hook: 'Everyone is asleep. We are on our second batch.',
      body: ['The ovens go on at 3:30', 'Shaping by hand', 'First loaves out at 6'],
      cta: 'Come and say hello',
      why: 'A story-open hook pulls people into a moment they never see.',
    }),
    card(
      'sug-starter-day',
      'carousel',
      b,
      {
        title: 'Feed your starter like this',
        hook: 'Your starter is hungrier than you think.',
        body: ['Feed it twice a day', 'Equal flour and water', 'Watch it double'],
        cta: 'Ask us for a spoonful of ours',
        why: 'A contrarian hook challenges a habit, then gives a clear routine.',
      },
      { slides: slides(['sourdough', 'baker', 'flatlay']) },
    ),
  ];
}

let deck: Card[] | null = null;
const decided = new Set<string>();
let swipesToday = 6;

route('GET', '/blitz', async () => {
  deck ??= await freshDeck();
  const cards = deck.filter((c) => !decided.has(c.id));
  return {
    deck: {
      cards,
      rendering: cards.length < 3 ? 1 : 0,
      swipesToday,
      swipesLeft: Math.max(0, 60 - swipesToday),
      caps: { rendersToday: 4, rendersLeftToday: 16, monthSpendPence: 0, premadeAllowed: true },
      paused: null,
    },
  };
});

route('POST', '/blitz/refill', async () => {
  deck = await freshDeck();
  decided.clear();
  return { status: 202, body: { queued: true } };
});

const FEWER: Record<string, (c: Card) => Record<string, unknown>> = {
  not_my_style: (c) => ({ kind: 'fewer_format', format: c.format }),
  wrong_topic: (c) => ({ kind: 'fewer_angle', angleTitle: c.angle.title }),
  seen_it: (c) => ({ kind: 'fewer_angle', angleTitle: c.angle.title }),
  too_salesy: () => ({ kind: 'less_salesy' }),
};

route('POST', '/blitz/suggestions/:id/decision', ({ params, body }) => {
  const c = deck?.find((x) => x.id === params.id);
  if (!c) throw new DemoHttpError(404, 'not_found', 'Card not found');
  if (decided.has(c.id)) throw new DemoHttpError(409, 'conflict', 'This card was already swiped');
  const b = (body ?? {}) as { action?: string; mode?: string; reason?: string };
  decided.add(c.id);
  swipesToday += 1;
  if (b.action === 'skip') {
    if (b.reason === 'not_my_style')
      mix.adjustments.formats[c.format] = (mix.adjustments.formats[c.format] ?? 0) - 5;
    return {
      result: {
        suggestionId: c.id,
        action: 'skip',
        projectId: null,
        publish: null,
        scheduledFor: null,
        downloadOnly: [],
        notice: b.reason ? (FEWER[b.reason]?.(c) ?? null) : null,
      },
    };
  }
  const mode = b.mode ?? 'schedule';
  return {
    result: {
      suggestionId: c.id,
      action: 'keep',
      projectId: c.format === 'carousel' ? 'prj-bread-tips-carousel' : PROJECTS.fiveBakes.id,
      publish: mode === 'edit' ? 'edit' : mode === 'schedule' ? 'scheduled' : 'posting',
      scheduledFor: mode === 'schedule' ? new Date(Date.now() + DAY).toISOString() : null,
      downloadOnly: c.format === 'carousel' ? ['tiktok'] : [],
      notice: null,
    },
  };
});

// ------------------------------------------------------------------ angles and mix

route('GET', '/businesses/:id/angles', () => ({ angles, max: 100 }));

route('POST', '/businesses/:id/angles', ({ body }) => {
  const b = (body ?? {}) as Partial<DemoAngle>;
  const title = String(b.title ?? '').trim();
  if (!title) throw new DemoHttpError(400, 'validation_error', 'Title is required');
  if (angles.some((a) => !a.retired && a.title.toLowerCase() === title.toLowerCase()))
    throw new DemoHttpError(409, 'conflict', 'An angle with this title already exists');
  const angle: DemoAngle = {
    id: `ang-${Date.now()}`,
    title,
    description: String(b.description ?? ''),
    targetAudience: String(b.targetAudience ?? ''),
    weight: Number(b.weight ?? 50),
    source: 'owner',
    retired: false,
  };
  angles.push(angle);
  return { status: 201, body: { angle } };
});

route('PATCH', '/businesses/:id/angles/:angleId', ({ params, body }) => {
  const angle = angles.find((a) => a.id === params.angleId);
  if (!angle) throw new DemoHttpError(404, 'not_found', 'Angle not found');
  Object.assign(angle, body ?? {});
  return { angle };
});

route('POST', '/businesses/:id/angles/suggest', () => {
  const fresh: DemoAngle = {
    id: `ang-ai-${Date.now()}`,
    title: 'Seasonal loaves',
    description: 'What is in the oven this month',
    targetAudience: 'regulars',
    weight: 50,
    source: 'ai',
    retired: false,
  };
  if (angles.some((a) => a.title === fresh.title)) return { status: 201, body: { angles: [] } };
  angles.push(fresh);
  return { status: 201, body: { angles: [fresh] } };
});

function mixView() {
  const available: Format[] = ['carousel', 'slideshow', 'ai_video', 'ugc'];
  return {
    available,
    formatWeights: mix.formatWeights,
    effectiveFormatWeights: Object.fromEntries(
      available.map((f) => [
        f,
        mix.formatWeights[f] > 0
          ? Math.max(1, mix.formatWeights[f] + (mix.adjustments.formats[f] ?? 0))
          : 0,
      ]),
    ),
    remixPercent: mix.remixPercent,
    mentionBusinessPercent: mix.mentionBusinessPercent,
    effectiveMentionPercent: mix.mentionBusinessPercent + mix.adjustments.mention,
    captionStyleWeights: null,
    creatorChance: 0,
    adjustments: [
      ...Object.entries(mix.adjustments.formats)
        .filter(([, d]) => d !== 0)
        .map(([id, delta]) => ({ target: 'format', id, delta })),
    ],
  };
}

route('GET', '/businesses/:id/content-mix', () => ({ mix: mixView() }));

route('PUT', '/businesses/:id/content-mix', ({ body }) => {
  const b = (body ?? {}) as {
    formatWeights?: Partial<Record<Format, number>>;
    remixPercent?: number;
    mentionBusinessPercent?: number;
    resetAdjustments?: boolean;
  };
  Object.assign(mix.formatWeights, b.formatWeights ?? {});
  if (typeof b.remixPercent === 'number') mix.remixPercent = b.remixPercent;
  if (typeof b.mentionBusinessPercent === 'number')
    mix.mentionBusinessPercent = b.mentionBusinessPercent;
  if (b.resetAdjustments) mix.adjustments = { formats: {}, angles: {}, mention: 0 };
  return { mix: mixView() };
});

// ------------------------------------------------------------------ automations

interface DemoAutomation {
  id: string;
  businessId: string;
  name: string;
  status: string;
  cadence: { mode: 'per_day'; postsPerDay: number } | { mode: 'per_week'; postsPerWeek: number };
  duration: string;
  ongoing: boolean;
  platforms: string[];
  targets: Array<{ platform: string; connectionId: string | null }>;
  approvalMode: 'review' | 'auto';
  timezone: string;
  language: string;
  periodIndex: number;
  currentPlanId: string | null;
  pauseReason: string | null;
  activatedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  insight: unknown;
}

function slotsFor(start: number, count: number, reviewing: boolean) {
  const titles = [
    ['carousel', '3 reasons your sourdough is flat'],
    ['slideshow', 'Your slow Saturday, sorted'],
    ['carousel', 'Feed your starter like this'],
    ['slideshow', 'Five loaves, five breakfasts'],
    ['carousel', 'What “artisan” really means'],
    ['slideshow', 'A morning at the ovens'],
    ['carousel', 'Crust or crumb?'],
  ] as const;
  return Array.from({ length: count }, (_, i) => {
    const [format, title] = titles[i % titles.length]!;
    return {
      id: `slot-${start}-${i}`,
      position: i,
      slotAt: new Date(start + i * DAY + 12 * HOUR).toISOString(),
      kind: format === 'carousel' ? 'CAROUSEL' : 'SLIDESHOW',
      format,
      angle: 'Weekend bakes',
      angleId: 'ang-weekend',
      title: title as string,
      brief: '',
      slides: {
        hook: title,
        points: ['One idea per slide', 'Large text', 'Close on the product'],
        cta: 'Order today',
      },
      calendarDay: null,
      postCopy: null,
      status: reviewing ? 'PLANNED' : i < 2 ? 'POSTED' : 'SCHEDULED',
      statusReason: null,
      projectId: reviewing ? null : PROJECTS.fiveBakes.id,
      reviewed: false,
      downloadOnly: format === 'carousel' ? ['tiktok'] : [],
    };
  });
}

const now = Date.now();
const automations: DemoAutomation[] = [
  {
    id: 'aut-weekly',
    businessId: 'biz-leeds-sourdough',
    name: '1 a day, every week',
    status: 'ACTIVE',
    cadence: { mode: 'per_day', postsPerDay: 1 },
    duration: 'ongoing_weekly',
    ongoing: true,
    platforms: ['instagram_feed', 'tiktok'],
    targets: [{ platform: 'tiktok', connectionId: 'conn-tiktok' }],
    approvalMode: 'auto',
    timezone: 'Europe/London',
    language: 'en-GB',
    periodIndex: 3,
    currentPlanId: 'plan-aut-3',
    pauseReason: null,
    activatedAt: new Date(now - 15 * DAY).toISOString(),
    pausedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: new Date(now - 15 * DAY).toISOString(),
    insight: {
      at: new Date(now - DAY).toISOString(),
      itemId: 'slot-x',
      title: '3 reasons your sourdough is flat',
      format: 'carousel',
      views: 4120,
    },
  },
  {
    id: 'aut-review',
    businessId: 'biz-leeds-sourdough',
    name: '3 a week, review first',
    status: 'REVIEW',
    cadence: { mode: 'per_week', postsPerWeek: 3 },
    duration: 'four_weeks',
    ongoing: false,
    platforms: ['instagram_feed', 'facebook_feed'],
    targets: [],
    approvalMode: 'review',
    timezone: 'Europe/London',
    language: 'en-GB',
    periodIndex: 1,
    currentPlanId: 'plan-aut-review',
    pauseReason: null,
    activatedAt: new Date(now - HOUR).toISOString(),
    pausedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: new Date(now - HOUR).toISOString(),
    insight: null,
  },
];
const periods = new Map<string, ReturnType<typeof slotsFor>>([
  ['aut-weekly', slotsFor(now - 2 * DAY, 7, false)],
  ['aut-review', slotsFor(now + DAY, 6, true)],
]);

function detail(a: DemoAutomation) {
  const items = periods.get(a.id) ?? [];
  return {
    automation: a,
    periods: [
      {
        id: a.currentPlanId ?? `plan-${a.id}`,
        status: a.status === 'REVIEW' ? 'DRAFT' : 'SCHEDULED',
        startDate: (items[0]?.slotAt ?? new Date().toISOString()).slice(0, 10),
        days: 7,
        timezone: a.timezone,
        holdReason: a.status === 'PAUSED' ? 'paused' : null,
        cappedReason: null,
        items,
      },
    ],
  };
}

function find(id: string | undefined) {
  const a = automations.find((x) => x.id === id);
  if (!a) throw new DemoHttpError(404, 'not_found', 'Automation not found');
  return a;
}

route('GET', '/automations', () => ({ automations }));

route('POST', '/automations/estimate', ({ body }) => {
  const b = (body ?? {}) as { cadence?: DemoAutomation['cadence']; duration?: string };
  const days = b.duration === 'four_weeks' || b.duration === 'ongoing_monthly' ? 28 : 7;
  const posts =
    b.cadence?.mode === 'per_week'
      ? Math.round((b.cadence.postsPerWeek * days) / 7)
      : (b.cadence?.postsPerDay ?? 1) * days;
  const carousels = Math.ceil(posts / 2);
  return {
    estimate: {
      posts,
      periodDays: days,
      ongoing: Boolean(b.duration?.startsWith('ongoing')),
      split: { carousel: carousels, slideshow: posts - carousels },
      paidPosts: 0,
      allowanceUnits: posts,
    },
  };
});

route('POST', '/automations', ({ body }) => {
  const b = (body ?? {}) as Partial<DemoAutomation>;
  const a: DemoAutomation = {
    ...automations[1]!,
    id: `aut-${Date.now()}`,
    name: b.name ?? 'New automation',
    status: 'DRAFT',
    cadence: b.cadence ?? { mode: 'per_day', postsPerDay: 1 },
    duration: b.duration ?? 'ongoing_weekly',
    ongoing: String(b.duration ?? '').startsWith('ongoing'),
    platforms: b.platforms ?? ['instagram_feed'],
    approvalMode: b.approvalMode ?? 'review',
    periodIndex: 0,
    currentPlanId: null,
    createdAt: new Date().toISOString(),
  };
  automations.unshift(a);
  return { status: 201, body: { automation: a } };
});

route('GET', '/automations/:id', ({ params }) => detail(find(params.id)));

route('POST', '/automations/:id/slots/:itemId', ({ params, body }) => {
  const a = find(params.id);
  const items = periods.get(a.id) ?? [];
  const action = (body as { action?: string } | null)?.action;
  const index = items.findIndex((i) => i.id === params.itemId);
  if (index < 0) throw new DemoHttpError(404, 'not_found', 'Slot not found');
  if (action === 'skip') items.splice(index, 1);
  else if (action === 'reroll')
    items[index] = { ...items[index]!, title: 'A fresh take on crust', reviewed: true };
  else items[index] = { ...items[index]!, reviewed: true };
  return detail(a);
});

route('POST', '/automations/:id/:action', ({ params }) => {
  const a = find(params.id);
  switch (params.action) {
    case 'start':
      a.status = a.approvalMode === 'review' ? 'REVIEW' : 'ACTIVE';
      a.periodIndex = 1;
      a.currentPlanId = `plan-${a.id}`;
      periods.set(a.id, slotsFor(Date.now() + DAY, 5, a.status === 'REVIEW'));
      break;
    case 'approve':
      a.status = 'ACTIVE';
      periods.set(
        a.id,
        (periods.get(a.id) ?? []).map((i) => ({
          ...i,
          status: 'SCHEDULED',
          projectId: PROJECTS.fiveBakes.id,
        })),
      );
      break;
    case 'pause':
      a.status = 'PAUSED';
      a.pauseReason = 'owner';
      break;
    case 'resume':
      a.status = 'ACTIVE';
      a.pauseReason = null;
      break;
    case 'cancel':
      a.status = 'CANCELLED';
      break;
    case 'more-like-this':
      mix.adjustments.formats.carousel = Math.min(20, (mix.adjustments.formats.carousel ?? 0) + 10);
      return { nudged: { format: 'carousel', angle: null }, ...detail(a) };
    default:
      throw new DemoHttpError(404, 'not_found', 'Unknown automation action');
  }
  return { automation: a };
});
