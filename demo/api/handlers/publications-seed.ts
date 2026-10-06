// Seed rows for the shared publications store (publications-store.ts). Every date is relative to
// page load so the Publications list and the Calendar always look current: history over the last
// ~10 weeks, and a posting plan through this month and next. Projects come from ids.ts so each
// row links to a real project in the demo.
import type { Publication } from '@/lib/client/types';
import { CONNECTIONS, PROJECTS, PUBLICATIONS, RENDERS } from '../ids';
import { demoHashtags } from '../hashtags-data';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LOADED_AT = Date.now();

/** A local-time moment `days` from today at hh:mm (so posts land at sensible posting times). */
function at(days: number, hh: number, mm = 0): string {
  const d = new Date(LOADED_AT + days * DAY);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}
const before = (isoTime: string, ms: number) => new Date(Date.parse(isoTime) - ms).toISOString();

type Platform =
  'tiktok' | 'instagram_reel' | 'youtube_short' | 'youtube' | 'linkedin_video' | 'x' | 'facebook';

const ACCOUNT: Record<Platform, string> = {
  tiktok: CONNECTIONS.tiktok.accountId,
  instagram_reel: CONNECTIONS.instagram.accountId,
  youtube_short: CONNECTIONS.youtube.accountId,
  youtube: CONNECTIONS.youtube.accountId,
  linkedin_video: CONNECTIONS.linkedin.accountId,
  x: CONNECTIONS.x.accountId,
  facebook: CONNECTIONS.facebook.accountId,
};

let postSeq = 7_421_000_000_100;
/** Platform post id + the public URL the real publisher returns (TikTok, X, YouTube: none). */
export function platformPost(platform: string): {
  platformPostId: string;
  platformUrl: string | null;
} {
  postSeq += 137;
  const n = String(postSeq);
  switch (platform) {
    case 'instagram_reel':
      return {
        platformPostId: `1790${n}`,
        platformUrl: `https://www.instagram.com/reel/DA${n.slice(-8)}/`,
      };
    case 'facebook':
      return { platformPostId: `1220${n}`, platformUrl: `https://www.facebook.com/reel/1220${n}` };
    case 'linkedin_video':
      return {
        platformPostId: `urn:li:ugcPost:${n}`,
        platformUrl: `https://www.linkedin.com/feed/update/urn:li:ugcPost:${n}/`,
      };
    case 'youtube':
    case 'youtube_short':
      return { platformPostId: `yt${n.slice(-9)}`, platformUrl: null };
    default:
      return { platformPostId: n, platformUrl: null };
  }
}

interface Spec {
  id: string;
  project: { id: string; name: string };
  renderId: string;
  platform: Platform;
  state: 'SCHEDULED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED' | 'CANCELLED' | 'TAKEN_DOWN';
  /** When it went (or goes) out. */
  when: string;
  caption: string;
  hashtags: string[];
  error?: { reason: string; code: string };
  retryCount?: number;
  /** Scheduled ahead (true) or published straight away. */
  scheduled?: boolean;
  /** Per-platform extras (22.7: a TikTok post sent to the TikTok drafts). */
  metadata?: Record<string, unknown>;
}

/** 22.7: what the worker stores for a post sent to the creator's TikTok drafts. */
const TIKTOK_DRAFT_METADATA = {
  tiktokMode: 'inbox',
  inboxReason: 'drafts',
  note: 'Sent to your TikTok drafts. Open the TikTok app, add a trending sound, finish posting from the notification, and keep the "AI-generated content" label switched on.',
};

function row(s: Spec): Publication {
  const live = s.state === 'PUBLISHED' || s.state === 'TAKEN_DOWN';
  const post = live ? platformPost(s.platform) : { platformPostId: null, platformUrl: null };
  const scheduled = s.scheduled ?? s.state === 'SCHEDULED';
  return {
    id: s.id,
    projectId: s.project.id,
    renderId: s.renderId,
    platform: s.platform,
    platformAccountId: ACCOUNT[s.platform],
    state: s.state,
    scheduledFor: scheduled ? s.when : null,
    publishedAt: live ? s.when : null,
    platformPostId: post.platformPostId,
    platformUrl: s.state === 'TAKEN_DOWN' ? null : post.platformUrl,
    caption: s.caption,
    // 20.13: every sample post carries the business hashtag first and at least five.
    hashtags: demoHashtags(s.hashtags, s.platform),
    errorReason: s.error?.reason ?? null,
    errorCode: s.error?.code ?? null,
    retryCount: s.retryCount ?? 0,
    createdAt: before(s.when, scheduled ? 5 * DAY : 20 * 60_000),
    project: { id: s.project.id, name: s.project.name },
    ...(s.metadata && { metadata: s.metadata }),
  };
}

const cls = PROJECTS.sourdoughClass;
const ritual = PROJECTS.morningRitual;
const wholesale = PROJECTS.wholesale;
const buns = PROJECTS.hotCrossBuns;

const CLASS = {
  caption:
    'Never baked sourdough? Our Saturday class takes you from starter to crackly loaf in three hours. Six places, 10am, flour on us. Book at the counter or in bio.',
  tags: ['sourdough', 'leeds', 'bakingclass', 'leedsfood'],
};
const RITUAL = {
  caption:
    '5am in Chapel Allerton: ovens on, starter fed, first loaves out by 7. This is our morning ritual — come and get it warm.',
  tags: ['bakerylife', 'pov', 'leeds', 'sourdough'],
};
const WHOLESALE = {
  caption:
    'Running a café in Leeds? We deliver sourdough, focaccia and pastries before 7am, six days a week. Tasting box for new stockists — message us.',
  tags: ['wholesale', 'leedscafes', 'independentleeds'],
};
const WEEKLY = [
  [
    'Cardamom buns are back this Friday — only 80 made, and they go by 10.',
    ['cardamombun', 'leedsbakery'],
  ],
  ['Seeded rye, 36-hour ferment. Slice thin, butter thick.', ['rye', 'sourdough', 'realbread']],
  [
    'Our focaccia, three steps, zero mixer. Rosemary from the back garden.',
    ['focaccia', 'bakeathome'],
  ],
  [
    'Pastel de nata Saturdays start this week. Custard still wobbling.',
    ['pasteldenata', 'leedsfood'],
  ],
  ['Pumpkin & sage loaf is on for October. Pre-order online.', ['autumnbakes', 'seasonal']],
  ['Behind the counter: laminating 300 croissants before sunrise.', ['croissant', 'bakerylife']],
] as const;

function ritualSeries(): Spec[] {
  // Auto-publish series from the "Our morning ritual" template: two posts a week, alternating
  // TikTok / Shorts / Reels, running through this month and next.
  const platforms: Platform[] = ['tiktok', 'youtube_short', 'instagram_reel', 'facebook'];
  const render: Record<Platform, string> = {
    tiktok: RENDERS.ritualTiktok,
    youtube_short: RENDERS.ritualShorts,
    instagram_reel: `${RENDERS.ritualTiktok}-reels`,
    facebook: `${RENDERS.ritualTiktok}-fb`,
    youtube: RENDERS.ritualShorts,
    linkedin_video: RENDERS.ritualShorts,
    x: RENDERS.ritualTiktok,
  };
  const offsets = [-26, -23, -19, -16, -12, -9, -5, -2, 5, 9, 12, 16, 19, 23, 26, 30, 33, 37, 40];
  return offsets.map((days, i) => {
    const platform = platforms[i % platforms.length] as Platform;
    const weekly = WEEKLY[i % WEEKLY.length] as (typeof WEEKLY)[number];
    return {
      id: `pub-series-${String(i + 1).padStart(2, '0')}`,
      project: ritual,
      renderId: render[platform],
      platform,
      state: days < 0 ? 'PUBLISHED' : 'SCHEDULED',
      scheduled: true,
      when: at(days, i % 2 ? 17 : 7, 30),
      caption: weekly[0],
      hashtags: [...weekly[1]],
    } satisfies Spec;
  });
}

const CATALOGUE: Spec[] = [
  // The ids.ts publications (other screens refer to these ids).
  {
    id: PUBLICATIONS.classTiktok,
    project: cls,
    renderId: RENDERS.classTiktok,
    platform: 'tiktok',
    state: 'PUBLISHED',
    when: at(-6, 18, 0),
    caption: CLASS.caption,
    hashtags: CLASS.tags,
  },
  {
    id: PUBLICATIONS.classShorts,
    project: cls,
    renderId: RENDERS.classShorts,
    platform: 'youtube_short',
    state: 'PUBLISHED',
    when: at(-6, 18, 5),
    caption: CLASS.caption,
    hashtags: CLASS.tags,
  },
  {
    id: PUBLICATIONS.classReels,
    project: cls,
    renderId: RENDERS.classReels,
    platform: 'instagram_reel',
    state: 'PUBLISHED',
    when: at(-6, 18, 10),
    caption: CLASS.caption,
    hashtags: CLASS.tags,
  },
  {
    id: PUBLICATIONS.wholesaleYoutube,
    project: wholesale,
    renderId: RENDERS.wholesaleYoutube,
    platform: 'youtube',
    state: 'PUBLISHED',
    when: at(-2, 9, 0),
    caption: WHOLESALE.caption,
    hashtags: WHOLESALE.tags,
  },
  {
    id: PUBLICATIONS.wholesaleLinkedin,
    project: wholesale,
    renderId: RENDERS.wholesaleLinkedin,
    platform: 'linkedin_video',
    state: 'FAILED',
    when: at(-2, 9, 0),
    caption: WHOLESALE.caption,
    hashtags: WHOLESALE.tags,
    retryCount: 3,
    error: {
      reason:
        'LinkedIn rejected the upload: the video is longer than the 10 minutes a page post allows',
      code: 'invalid_request',
    },
  },
  {
    id: PUBLICATIONS.ritualTiktokScheduled,
    project: ritual,
    renderId: RENDERS.ritualTiktok,
    platform: 'tiktok',
    state: 'SCHEDULED',
    when: at(2, 7, 30),
    caption: RITUAL.caption,
    hashtags: RITUAL.tags,
  },
  {
    id: PUBLICATIONS.ritualShortsScheduled,
    project: ritual,
    renderId: RENDERS.ritualShorts,
    platform: 'youtube_short',
    state: 'SCHEDULED',
    when: at(2, 8, 0),
    caption: RITUAL.caption,
    hashtags: RITUAL.tags,
  },
  {
    id: PUBLICATIONS.bunsLastYear,
    project: buns,
    renderId: RENDERS.bunsTiktok,
    platform: 'tiktok',
    state: 'TAKEN_DOWN',
    when: at(-190, 8, 0),
    caption: 'Hot cross buns are back! Spiced, glazed, gone by noon.',
    hashtags: ['easter', 'hotcrossbuns'],
  },
  // More history and every other state.
  {
    id: 'pub-class-facebook',
    project: cls,
    renderId: `${RENDERS.classReels}-fb`,
    platform: 'facebook',
    state: 'PUBLISHED',
    when: at(-5, 12, 15),
    caption: CLASS.caption,
    hashtags: CLASS.tags,
  },
  {
    id: 'pub-class-linkedin',
    project: cls,
    renderId: `${RENDERS.classShorts}-li`,
    platform: 'linkedin_video',
    state: 'PUBLISHED',
    when: at(-5, 8, 45),
    caption:
      'Team-building idea for Leeds offices: a private sourdough class for up to 8, in our bakehouse.',
    hashtags: ['teambuilding', 'leeds'],
  },
  {
    id: 'pub-class-x',
    project: cls,
    renderId: `${RENDERS.classTiktok}-x`,
    platform: 'x',
    state: 'FAILED',
    when: at(-5, 12, 0),
    caption: 'Saturday sourdough class — 6 places left. 10am, Chapel Allerton.',
    hashtags: ['leeds', 'sourdough'],
    error: {
      // 17.9: stored as the publisher stores it (`<platform>/<errorClass>: <the platform's message>`).
      reason: 'x/needs_reconnect: The access token was revoked',
      code: 'needs_reconnect',
    },
  },
  {
    id: 'pub-ritual-instagram-now',
    project: ritual,
    renderId: `${RENDERS.ritualTiktok}-reels`,
    platform: 'instagram_reel',
    state: 'PUBLISHING',
    when: at(0, 7, 30),
    scheduled: true,
    caption: RITUAL.caption,
    hashtags: RITUAL.tags,
  },
  {
    id: 'pub-ritual-x-cancelled',
    project: ritual,
    renderId: `${RENDERS.ritualTiktok}-x`,
    platform: 'x',
    state: 'CANCELLED',
    when: at(3, 12, 0),
    scheduled: true,
    caption: RITUAL.caption,
    hashtags: RITUAL.tags,
  },
  {
    id: 'pub-wholesale-facebook-cancelled',
    project: wholesale,
    renderId: `${RENDERS.wholesaleYoutube}-fb`,
    platform: 'facebook',
    state: 'CANCELLED',
    when: at(8, 9, 0),
    scheduled: true,
    caption: WHOLESALE.caption,
    hashtags: WHOLESALE.tags,
  },
  {
    id: 'pub-wholesale-linkedin-next',
    project: wholesale,
    renderId: `${RENDERS.wholesaleLinkedin}-cut`,
    platform: 'linkedin_video',
    state: 'SCHEDULED',
    when: at(14, 8, 30),
    caption: 'Café owners: book a free tasting box for your team this autumn.',
    hashtags: WHOLESALE.tags,
  },
  {
    id: 'pub-wholesale-tiktok-old',
    project: wholesale,
    renderId: `${RENDERS.wholesaleYoutube}-tt`,
    platform: 'tiktok',
    state: 'TAKEN_DOWN',
    when: at(-44, 13, 0),
    caption: 'Our van, 5:40am, 14 cafés to go.',
    hashtags: ['wholesale', 'leeds'],
  },
  {
    id: 'pub-buns-reels-2025',
    project: buns,
    renderId: `${RENDERS.bunsTiktok}-reels`,
    platform: 'instagram_reel',
    state: 'PUBLISHED',
    when: at(-189, 8, 0),
    caption: 'Hot cross buns are back! Spiced, glazed, gone by noon.',
    hashtags: ['easter', 'hotcrossbuns'],
  },
  {
    id: 'pub-class-tiktok-teaser',
    project: cls,
    renderId: `${RENDERS.classTiktok}-teaser`,
    platform: 'tiktok',
    state: 'PUBLISHED',
    when: at(-33, 19, 0),
    caption: 'Guess the hydration. Wrong answers only. (It’s 78%.)',
    hashtags: ['sourdough', 'bakingtok'],
    // 22.7: shows "Sent to TikTok drafts" (finish it in the TikTok app).
    metadata: TIKTOK_DRAFT_METADATA,
  },
  {
    id: 'pub-class-shorts-teaser',
    project: cls,
    renderId: `${RENDERS.classShorts}-teaser`,
    platform: 'youtube_short',
    state: 'PUBLISHED',
    when: at(-40, 19, 0),
    caption: 'Shaping a batard in 20 seconds.',
    hashtags: ['sourdough', 'shorts'],
  },
  {
    id: 'pub-class-reels-teaser',
    project: cls,
    renderId: `${RENDERS.classReels}-teaser`,
    platform: 'instagram_reel',
    state: 'PUBLISHED',
    when: at(-52, 18, 30),
    caption: 'Ear, bloom, crackle. Class dates for autumn are up.',
    hashtags: ['sourdough', 'leedsfood'],
  },
  {
    id: 'pub-wholesale-youtube-tour',
    project: wholesale,
    renderId: `${RENDERS.wholesaleYoutube}-tour`,
    platform: 'youtube',
    state: 'PUBLISHED',
    when: at(-61, 10, 0),
    caption: 'A tour of the bakehouse for new wholesale partners.',
    hashtags: ['wholesale'],
  },
  {
    id: 'pub-ritual-reels-dec',
    project: ritual,
    renderId: `${RENDERS.ritualTiktok}-reels-2`,
    platform: 'instagram_reel',
    state: 'SCHEDULED',
    when: at(44, 7, 30),
    caption: 'Frosty mornings, warm loaves. Winter hours start next week.',
    hashtags: ['bakerylife', 'winter'],
  },
];

export function seedPublications(): Publication[] {
  return [...CATALOGUE, ...ritualSeries()].map(row);
}
