// Phase 13 track A4 demo handlers: per-publication analytics with YouTube retention and audience
// (13.28) and style memory (13.29). Shapes match src/lib/studio/services/analytics.ts
// publicationAnalytics and services/style-memory.ts.
import { DEMO_BUSINESS_ID, PROJECTS } from '../ids';
import { DemoHttpError, route } from '../registry';
import { countsAt, livePosts, type Counts } from './analytics-model';
import { allProjects, setMeta } from './projects-store';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const YOUTUBE = new Set(['youtube', 'youtube_short']);

function point(at: number, c: Counts) {
  return { at: new Date(at).toISOString(), ...c };
}

/** A plausible audienceWatchRatio curve: early drop-off, a mid plateau, a small end bump. */
function retentionCurve(seed: number): Array<{ atPct: number; watchingPct: number }> {
  const out: Array<{ atPct: number; watchingPct: number }> = [];
  for (let i = 1; i <= 100; i++) {
    const x = i / 100;
    const ratio = 0.42 + 0.5 * Math.exp(-x * (3.4 + seed)) + (x > 0.93 ? 0.04 : 0);
    out.push({ atPct: x, watchingPct: Math.round(ratio * 1000) / 1000 });
  }
  return out;
}

const DEMOGRAPHICS = [
  { ageGroup: '25-34', gender: 'female', pct: 24.6 },
  { ageGroup: '25-34', gender: 'male', pct: 14.2 },
  { ageGroup: '35-44', gender: 'female', pct: 17.9 },
  { ageGroup: '35-44', gender: 'male', pct: 9.8 },
  { ageGroup: '18-24', gender: 'female', pct: 11.3 },
  { ageGroup: '18-24', gender: 'male', pct: 6.1 },
  { ageGroup: '45-54', gender: 'female', pct: 8.4 },
  { ageGroup: '45-54', gender: 'male', pct: 3.9 },
  { ageGroup: '55-64', gender: 'female', pct: 2.6 },
  { ageGroup: '65+', gender: 'male', pct: 1.2 },
];

route('GET', '/analytics/publications/:id', ({ params }) => {
  const post = livePosts().find((p) => p.pub.id === params.id);
  if (!post) throw new DemoHttpError(404, 'not_found', 'Publication not found');
  const now = Date.now();
  const hourly: Array<ReturnType<typeof point>> = [];
  const daily: Array<ReturnType<typeof point>> = [];
  const firstHour = Math.ceil(post.publishedMs / HOUR) * HOUR;
  for (let t = Math.max(firstHour, now - 30 * DAY); t <= now; t += HOUR) {
    hourly.push(point(t, countsAt(post, t)));
  }
  const firstDay = Math.ceil(post.publishedMs / DAY) * DAY;
  for (let t = firstDay; t <= now; t += DAY) daily.push(point(t, countsAt(post, t)));
  const latestCounts = countsAt(post, now);
  const youtube = YOUTUBE.has(post.pub.platform);
  const old = now - post.publishedMs >= DAY;
  return {
    publication: {
      id: post.pub.id,
      projectId: post.pub.projectId,
      renderId: post.pub.renderId,
      caption: post.pub.caption,
      platform: post.pub.platform,
      platformUrl: post.pub.platformUrl,
      publishedAt: post.pub.publishedAt,
      state: post.pub.state,
    },
    latest: {
      ...point(now, latestCounts),
      uniqueViewers: null,
      avgWatchTimePct: youtube ? 0.63 : null,
      clicks: 0,
    },
    hourly,
    daily,
    retention: youtube && old ? retentionCurve(post.pub.id.length % 3) : [],
    demographics: youtube && old ? DEMOGRAPHICS : [],
  };
});

// ---------------------------------------------------------------- style memory (13.29)

export interface Memory {
  id: string;
  signalType: string;
  value: string;
  details: Record<string, unknown>;
  reason: string;
  weight: number;
  evidenceCount: number;
  lastEvidenceAt: string | null;
  updatedAt: string;
  pinned?: boolean;
  disabled?: boolean;
}

const daysAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString();

let memories: Memory[] = [
  {
    id: 'sm-script',
    signalType: 'script_structure',
    value: 'hook in the first 1.2 s, about 4 shots',
    details: { hookWithinSec: 1.2, shotCount: 4, highRetention: 3, lowRetention: 1 },
    reason:
      '3 YouTube videos kept viewers over 60% (average 68%) with a 1.2 s opening shot; 1 video under 25% weakens other structures.',
    weight: 0.71,
    evidenceCount: 4,
    lastEvidenceAt: daysAgo(3),
    updatedAt: daysAgo(0),
  },
  {
    id: 'sm-pace',
    signalType: 'shot_pace',
    value: 'medium pace: about 3.8 s per shot, 5 shots per video',
    details: { avgShotSec: 3.8, shotsPerVideo: 5, pace: 'medium pace' },
    reason: '6 approved videos averaged 3.8 s per shot; 1 rejected video averaged 7.5 s.',
    weight: 0.64,
    evidenceCount: 6,
    lastEvidenceAt: daysAgo(2),
    updatedAt: daysAgo(0),
  },
  {
    id: 'sm-mix',
    signalType: 'treatment_mix',
    value: 'prefers 55% ai clip, 30% image still, 15% text card',
    details: {},
    reason: 'Across 31 shots in 6 approved videos: 55% ai clip, 30% image still, 15% text card.',
    weight: 0.64,
    evidenceCount: 6,
    lastEvidenceAt: daysAgo(2),
    updatedAt: daysAgo(0),
  },
  {
    id: 'sm-time',
    signalType: 'posting_time',
    value: 'videos posted around 07:00–09:00 UTC do best',
    details: { peakHourUtc: 7 },
    reason:
      'Your 5 most-viewed videos of the last 90 days were mostly published around 07:00–09:00 UTC.',
    weight: 0.58,
    evidenceCount: 5,
    lastEvidenceAt: daysAgo(4),
    updatedAt: daysAgo(0),
  },
  {
    id: 'sm-provider',
    signalType: 'provider_preference',
    value: 'runway shots are kept most often',
    details: {},
    reason: '19 approved shots came from runway; 2 openai shots regenerated.',
    weight: 0.52,
    evidenceCount: 21,
    lastEvidenceAt: daysAgo(2),
    updatedAt: daysAgo(0),
  },
];

/** 15.E6 (demo/api/handlers/p15-e-data-rights.ts): edit one memory in place. */
export function patchStyleMemory(
  memoryId: string,
  change: { value?: string; pinned?: boolean; disabled?: boolean },
): Memory | undefined {
  const i = memories.findIndex((m) => m.id === memoryId);
  const current = memories[i];
  if (!current) return undefined;
  const next = { ...current, ...change };
  memories = memories.map((m, j) => (j === i ? next : m));
  return next;
}

route('GET', '/businesses/:id/style-memory', ({ params }) => ({
  data: params.id === DEMO_BUSINESS_ID ? memories : [],
}));

route('DELETE', '/businesses/:id/style-memory/:memoryId', ({ params }) => {
  const found = params.id === DEMO_BUSINESS_ID && memories.some((m) => m.id === params.memoryId);
  if (!found) throw new DemoHttpError(404, 'not_found', 'Style memory not found');
  memories = memories.filter((m) => m.id !== params.memoryId);
  return { deleted: true };
});

// ---------------------------------------------------------------- SFX on review (13.27)

// The spring menu launch's Layer 2 script asked for two effects; one had no Storyblocks match.
const spring = allProjects().find((p) => p.id === PROJECTS.springMenu.id);
if (spring) {
  setMeta(spring, {
    sfx: {
      status: 'added',
      runId: 'demo',
      cues: [
        {
          cue: 'whoosh',
          shotIds: ['shot-a', 'shot-c'],
          status: 'added',
          title: 'Fast Air Whoosh',
          durationSec: 1.4,
        },
        { cue: 'oven door creak', shotIds: ['shot-b'], status: 'no_match' },
      ],
    },
  });
}
