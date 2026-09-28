import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { isValidTimeZone, wallClock } from '../automation/zoned-time';
import { PLATFORMS } from '../services/catalog';

// 15.A6 — best-time suggestions (spec 9.9 "analytics for the org's prior publications inform
// per-platform per-day best-hour recommendations. Not enforced — advisory only").
// Each published video counts once, in the (weekday, hour) it went live in the viewer's time
// zone, with its latest cumulative views (video_analytics rows are cumulative snapshots). A slot's
// score is its mean views relative to the best slot (0–1). Below MIN_VIDEOS videos the data is
// reported insufficient and, when the business has a learned POSTING_TIME style memory (13.29),
// that peak hour is suggested instead. Optional `language` narrows to videos in that language
// (audiences differ by language).

export const WINDOW_DAYS = 180;
export const MIN_VIDEOS = 8;
const MAX_ROWS = 2_000;
const TOP_SLOTS = 10;

export const bestTimesQuery = z.object({
  businessId: z.string().trim().min(1).max(128).optional(),
  platform: z.enum(PLATFORMS).optional(),
  language: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'language must be a BCP 47 tag')
    .optional(),
  timezone: z
    .string()
    .trim()
    .max(64)
    .refine(isValidTimeZone, { message: 'timezone must be an IANA time zone' })
    .default('UTC'),
});

export type BestTimesQuery = z.infer<typeof bestTimesQuery>;

export interface BestSlot {
  weekday: number;
  hour: number;
  score: number;
  basis: string;
}

interface Sample {
  publishedAt: Date;
  views: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Pure aggregation (exported for tests). */
export function aggregateBestTimes(
  samples: Sample[],
  timezone: string,
): { slots: BestSlot[]; bestPerDay: BestSlot[]; videos: number } {
  const buckets = new Map<string, { weekday: number; hour: number; views: number; n: number }>();
  for (const s of samples) {
    const w = wallClock(s.publishedAt.getTime(), timezone);
    const key = `${w.weekday}:${w.hour}`;
    const b = buckets.get(key) ?? { weekday: w.weekday, hour: w.hour, views: 0, n: 0 };
    b.views += s.views;
    b.n += 1;
    buckets.set(key, b);
  }
  const means = [...buckets.values()].map((b) => ({ ...b, mean: b.views / b.n }));
  const best = Math.max(0, ...means.map((m) => m.mean));
  const slots = means
    .map((m) => ({
      weekday: m.weekday,
      hour: m.hour,
      score: best > 0 ? Math.round((m.mean / best) * 100) / 100 : 0,
      basis: plural(m.n, 'video'),
    }))
    .sort((a, b) => b.score - a.score || a.weekday - b.weekday || a.hour - b.hour);
  const bestPerDay = [0, 1, 2, 3, 4, 5, 6].flatMap((day) => {
    const top = slots.find((s) => s.weekday === day);
    return top ? [top] : [];
  });
  return { slots: slots.slice(0, TOP_SLOTS), bestPerDay, videos: samples.length };
}

async function postingTimeMemory(
  db: PrismaClient,
  organisationId: string,
  businessId: string,
): Promise<{ peakHourUtc: number; summary: string } | null> {
  const row = await db.styleMemory.findFirst({
    where: { organisationId, businessId, signalType: 'POSTING_TIME', deletedAt: null },
    select: { value: true },
  });
  const value =
    row?.value && typeof row.value === 'object' && !Array.isArray(row.value)
      ? (row.value as Record<string, unknown>)
      : null;
  const peak = value?.peakHourUtc;
  if (typeof peak !== 'number' || !Number.isInteger(peak) || peak < 0 || peak > 23) return null;
  return {
    peakHourUtc: peak,
    summary: typeof value?.summary === 'string' ? value.summary : '',
  };
}

/** GET /analytics/best-times. */
export async function bestTimes(
  db: PrismaClient,
  organisationId: string,
  query: BestTimesQuery,
  now: number,
) {
  const rows = await db.videoPublication.findMany({
    where: {
      organisationId,
      state: { in: ['PUBLISHED', 'TAKEN_DOWN'] },
      publishedAt: { gte: new Date(now - WINDOW_DAYS * 86_400_000) },
      ...(query.platform && { platform: query.platform }),
      ...((query.businessId || query.language) && {
        project: {
          ...(query.businessId && { businessId: query.businessId }),
          ...(query.language && { language: query.language }),
        },
      }),
    },
    select: {
      publishedAt: true,
      analytics: { orderBy: { bucketAt: 'desc' }, take: 1, select: { views: true } },
    },
    orderBy: { publishedAt: 'desc' },
    take: MAX_ROWS,
  });
  const samples = rows.flatMap((r) =>
    r.publishedAt && r.analytics[0]
      ? [{ publishedAt: r.publishedAt, views: r.analytics[0].views }]
      : [],
  );
  const result = aggregateBestTimes(samples, query.timezone);
  const sufficientData = result.videos >= MIN_VIDEOS;
  const memory = query.businessId
    ? await postingTimeMemory(db, organisationId, query.businessId)
    : null;
  // The learned peak hour, shown in the requested time zone (today's offset).
  const memoryHour = memory
    ? wallClock(
        Date.UTC(
          new Date(now).getUTCFullYear(),
          new Date(now).getUTCMonth(),
          new Date(now).getUTCDate(),
          memory.peakHourUtc,
        ),
        query.timezone,
      ).hour
    : null;
  const fallback =
    !sufficientData && memoryHour !== null
      ? [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          hour: memoryHour,
          score: 1,
          basis: 'style memory',
        }))
      : null;
  return {
    data: result.slots,
    bestPerDay: sufficientData ? result.bestPerDay : (fallback ?? result.bestPerDay),
    sufficientData,
    videos: result.videos,
    minVideos: MIN_VIDEOS,
    timezone: query.timezone,
    platform: query.platform ?? null,
    styleMemory: memory
      ? { peakHourUtc: memory.peakHourUtc, hour: memoryHour, summary: memory.summary }
      : null,
    advisory: true,
  };
}
