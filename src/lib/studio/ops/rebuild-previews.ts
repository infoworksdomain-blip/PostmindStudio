import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { ValidationError } from '../../errors';
import {
  PREVIEW_CONTENT_TYPE,
  PREVIEW_MAX_SEC,
  PREVIEW_WIDTH,
  previewKey,
} from '../library/ingest';
import { THUMBNAIL_CACHE_CONTROL } from '../library/thumbnail-signing';
import type { MediaInspector } from '../pipeline/media-probe';
import { ffmpegConcurrencyFromEnv } from '../pipeline/process-limit';
import type { AssetStorage } from '../storage';

// BACKLOG 20.17 (operator decision 2026-10-01: reference-library previews play with sound) —
// one-off: regenerate the preview rendition of every live library item with
// media-probe.previewClip, which now keeps the audio, and overwrite previewKey(s3Key) in place.
// Same rendition, content type and Cache-Control as ingest.ts. Overwriting the key is safe for
// browsers despite the "immutable" header: previews are signed per request for 10 minutes
// (services/library.ts), so a new URL is never served from an old cached copy for long.
// No AI or provider calls: only storage, ffprobe and ffmpeg.

export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 8;
export const PAGE_SIZE = 100;
/** Signed source URLs must outlive one ffmpeg run (its timeout is 5 minutes). */
export const SOURCE_URL_TTL_SEC = 60 * 60;
const PROBE_URL_TTL_SEC = 10 * 60;

export interface LibraryPreviewSource {
  id: string;
  s3Bucket: string;
  s3Key: string;
}

/** Pages of live (not retired) library items, ordered by id. */
export interface LibraryPreviewItems {
  page(afterId: string | undefined, take: number): Promise<LibraryPreviewSource[]>;
}

export interface RebuildPreviewsDeps {
  items: LibraryPreviewItems;
  storage: Pick<AssetStorage, 'put' | 'signedUrl'>;
  media: Pick<MediaInspector, 'previewClip' | 'probe'>;
  log?: Pick<Logger, 'info' | 'warn'>;
}

export interface RebuildPreviewsOptions {
  dryRun: boolean;
  /** Stop after this many items (a trial run); undefined = all. */
  limit?: number;
  concurrency: number;
  /** Skip items whose current preview already has an audio stream (ffprobe). */
  onlyMissingAudio: boolean;
}

export type PreviewOutcome = 'rebuilt' | 'has-audio' | 'source-silent';

export interface RebuildPreviewsReport {
  dryRun: boolean;
  examined: number;
  /** Rebuilt (or, in a dry run, would be). */
  rebuilt: number;
  /** --only-missing-audio: the existing preview already has sound. */
  skippedHasAudio: number;
  /** --only-missing-audio: the source itself has no audio, so a rebuild would stay silent. */
  skippedSourceSilent: number;
  failed: Array<{ id: string; key: string; message: string }>;
}

/** Prisma-backed item pages (retired items are hidden from users, so they are left alone). */
export function prismaPreviewItems(
  db: Pick<PrismaClient, 'videoLibraryItem'>,
): LibraryPreviewItems {
  return {
    page: (afterId, take) =>
      db.videoLibraryItem.findMany({
        where: { retiredAt: null, ...(afterId && { id: { gt: afterId } }) },
        orderBy: { id: 'asc' },
        take,
        select: { id: true, s3Bucket: true, s3Key: true },
      }),
  };
}

/** --concurrency, capped by STUDIO_FFMPEG_MAX_CONCURRENT (run() would queue beyond it anyway). */
export function effectiveConcurrency(
  requested: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const cap = ffmpegConcurrencyFromEnv(env);
  return cap === undefined ? requested : Math.min(requested, cap);
}

async function hasAudio(
  deps: RebuildPreviewsDeps,
  bucket: string,
  key: string,
): Promise<boolean | null> {
  try {
    const url = await deps.storage.signedUrl(bucket, key, PROBE_URL_TTL_SEC);
    return (await deps.media.probe(url)).audioCodec !== null;
  } catch {
    // A missing or unreadable preview is exactly what a rebuild fixes.
    return null;
  }
}

async function rebuildOne(
  deps: RebuildPreviewsDeps,
  item: LibraryPreviewSource,
  options: RebuildPreviewsOptions,
): Promise<PreviewOutcome> {
  const target = previewKey(item.s3Key);
  // previewKey only rewrites "<name>.mp4"; any other key would map onto the source itself.
  if (target === item.s3Key)
    throw new ValidationError(`source key ${item.s3Key} has no .mp4 suffix; preview key unknown`);
  if (options.onlyMissingAudio) {
    if ((await hasAudio(deps, item.s3Bucket, target)) === true) return 'has-audio';
    const source = await deps.storage.signedUrl(item.s3Bucket, item.s3Key, PROBE_URL_TTL_SEC);
    if ((await deps.media.probe(source)).audioCodec === null) return 'source-silent';
  }
  if (options.dryRun) return 'rebuilt';
  const url = await deps.storage.signedUrl(item.s3Bucket, item.s3Key, SOURCE_URL_TTL_SEC);
  const body = await deps.media.previewClip(url, PREVIEW_WIDTH, PREVIEW_MAX_SEC);
  await deps.storage.put({
    bucket: item.s3Bucket,
    key: target,
    body,
    contentType: PREVIEW_CONTENT_TYPE,
    cacheControl: THUMBNAIL_CACHE_CONTROL,
  });
  return 'rebuilt';
}

function record(report: RebuildPreviewsReport, outcome: PreviewOutcome): void {
  if (outcome === 'rebuilt') report.rebuilt += 1;
  else if (outcome === 'has-audio') report.skippedHasAudio += 1;
  else report.skippedSourceSilent += 1;
}

/** Runs `work` over `items` with at most `concurrency` in flight; `work` must not throw. */
async function runPool<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(lanes);
}

function validate(options: RebuildPreviewsOptions): void {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1))
    throw new ValidationError('limit must be a positive integer');
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > MAX_CONCURRENCY
  )
    throw new ValidationError(`concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}`);
}

export async function rebuildLibraryPreviews(
  deps: RebuildPreviewsDeps,
  options: RebuildPreviewsOptions,
): Promise<RebuildPreviewsReport> {
  validate(options);
  const report: RebuildPreviewsReport = {
    dryRun: options.dryRun,
    examined: 0,
    rebuilt: 0,
    skippedHasAudio: 0,
    skippedSourceSilent: 0,
    failed: [],
  };
  let afterId: string | undefined;
  for (;;) {
    const remaining = options.limit === undefined ? PAGE_SIZE : options.limit - report.examined;
    if (remaining <= 0) break;
    const page = await deps.items.page(afterId, Math.min(PAGE_SIZE, remaining));
    if (page.length === 0) break;
    afterId = page.at(-1)?.id;
    report.examined += page.length;
    await runPool(page, options.concurrency, async (item) => {
      try {
        const outcome = await rebuildOne(deps, item, options);
        record(report, outcome);
        deps.log?.info({ id: item.id, outcome }, 'library preview');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.failed.push({ id: item.id, key: item.s3Key, message });
        deps.log?.warn({ id: item.id, key: item.s3Key, err: message }, 'library preview failed');
      }
    });
    deps.log?.info({ ...report, failed: report.failed.length }, 'library previews: progress');
  }
  return report;
}

export interface RebuildPreviewsArgs {
  dryRun: boolean;
  limit?: number;
  concurrency: number;
  onlyMissingAudio: boolean;
}

function positiveInt(flag: string, value: string | undefined): number {
  if (!value || value.startsWith('--')) throw new ValidationError(`${flag} needs a value`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new ValidationError(`${flag} must be a positive integer`);
  return n;
}

/** CLI flags: --dry-run, --limit <n>, --concurrency <n> (default 2), --only-missing-audio. */
export function parseRebuildPreviewsArgs(argv: string[]): RebuildPreviewsArgs {
  const args: RebuildPreviewsArgs = {
    dryRun: false,
    concurrency: DEFAULT_CONCURRENCY,
    onlyMissingAudio: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--only-missing-audio') args.onlyMissingAudio = true;
    else if (flag === '--limit' || flag === '--concurrency') {
      const n = positiveInt(flag, argv[i + 1]);
      i += 1;
      if (flag === '--limit') args.limit = n;
      else if (n > MAX_CONCURRENCY)
        throw new ValidationError(`--concurrency must be at most ${MAX_CONCURRENCY}`);
      else args.concurrency = n;
    } else throw new ValidationError(`unknown option ${flag}`);
  }
  return args;
}
