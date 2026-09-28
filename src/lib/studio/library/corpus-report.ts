import { ValidationError } from '../../errors';
import { NOT_REQUIRED_DEFAULT_SOURCE } from './ingest';
import { categoryDistribution, type ManifestRow, type RowError } from './corpus-manifest';
import type { RunStatus } from './corpus-run';

// BACKLOG 9.2 / 9.3 — argument parsing, the up-front cost/time estimate and the operator review
// report for scripts/ops/ingest-corpus.ts (pure; unit tested).

/** PROGRESS Phase 9: ~£0.02–£0.05 per video in provider calls (Claude vision, transcription,
 * embedding). Pence. */
export const COST_PER_VIDEO_PENCE = { low: 2, high: 5 } as const;
/**
 * ASSUMPTION (no measured figure yet — replace with the sample run's measured completedPerHour):
 * wall-clock minutes one library job holds a worker slot (download, ffprobe + scene detection,
 * keyframes, preview render, transcription wait, Claude analysis, embedding).
 */
export const DEFAULT_MINUTES_PER_VIDEO = 3;

export interface CorpusArgs {
  manifest: string;
  apply: boolean;
  statePath?: string;
  sample?: number;
  seed: number;
  /** HTTP batches in flight. */
  concurrency: number;
  /** STUDIO_LIBRARY_CONCURRENCY on each worker (for the estimate). */
  queueConcurrency: number;
  workers: number;
  minutesPerVideo: number;
  licenseSource: string;
  waitMinutes: number;
  reportOnly: boolean;
  /** Phase 14.9: check tier, concurrency, buckets and the manifest; submit nothing. */
  preflight: boolean;
}

const NUMERIC: Record<string, keyof CorpusArgs> = {
  '--sample': 'sample',
  '--seed': 'seed',
  '--concurrency': 'concurrency',
  '--queue-concurrency': 'queueConcurrency',
  '--workers': 'workers',
  '--minutes-per-video': 'minutesPerVideo',
  '--wait-minutes': 'waitMinutes',
};

export function parseCorpusArgs(argv: string[]): CorpusArgs {
  const args: CorpusArgs = {
    manifest: '',
    apply: false,
    seed: 1,
    concurrency: 2,
    queueConcurrency: 2,
    workers: 1,
    minutesPerVideo: DEFAULT_MINUTES_PER_VIDEO,
    licenseSource: NOT_REQUIRED_DEFAULT_SOURCE,
    waitMinutes: 180,
    reportOnly: false,
    preflight: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    if (flag === '--apply') args.apply = true;
    else if (flag === '--report') args.reportOnly = true;
    else if (flag === '--preflight') args.preflight = true;
    else if (flag === '--state' || flag === '--license-source') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new ValidationError(`${flag} needs a value`);
      if (flag === '--state') args.statePath = value;
      else args.licenseSource = value.trim().slice(0, 500);
      i += 1;
    } else if (NUMERIC[flag]) {
      const n = Number(argv[i + 1]);
      if (!(n > 0) || !Number.isFinite(n))
        throw new ValidationError(`${flag} needs a positive number`);
      Object.assign(args, { [NUMERIC[flag]]: n });
      i += 1;
    } else if (flag.startsWith('--')) throw new ValidationError(`unknown option ${flag}`);
    else if (!args.manifest) args.manifest = flag;
    else throw new ValidationError(`unexpected argument ${flag}`);
  }
  if (!args.manifest) throw new ValidationError('usage: ingest-corpus.ts <manifest.csv|.jsonl> …');
  for (const key of ['sample', 'concurrency', 'queueConcurrency', 'workers', 'seed'] as const) {
    const v = args[key];
    if (v !== undefined && !Number.isInteger(v))
      throw new ValidationError(`--${key} must be a whole number`);
  }
  if (args.preflight && (args.apply || args.reportOnly))
    throw new ValidationError('--preflight submits nothing: drop --apply / --report');
  if (args.concurrency > 8) throw new ValidationError('--concurrency is at most 8 batches');
  if (!args.licenseSource) throw new ValidationError('--license-source cannot be empty');
  return args;
}

export interface Estimate {
  videos: number;
  costLowGbp: number;
  costHighGbp: number;
  slots: number;
  hours: number;
}

/** Cost from the per-video range; time = videos × minutes ÷ (queue concurrency × workers). */
export function estimate(
  videos: number,
  opts: { minutesPerVideo: number; queueConcurrency: number; workers: number },
): Estimate {
  const slots = Math.max(1, opts.queueConcurrency * opts.workers);
  return {
    videos,
    costLowGbp: (videos * COST_PER_VIDEO_PENCE.low) / 100,
    costHighGbp: (videos * COST_PER_VIDEO_PENCE.high) / 100,
    slots,
    hours: Math.round(((videos * opts.minutesPerVideo) / slots / 60) * 10) / 10,
  };
}

export function formatEstimate(e: Estimate, minutesPerVideo: number): string {
  const days = e.hours >= 48 ? ` (~${Math.round((e.hours / 24) * 10) / 10} days)` : '';
  return [
    `Estimate for ${e.videos} videos:`,
    `  cost  £${e.costLowGbp.toFixed(2)}–£${e.costHighGbp.toFixed(2)} in provider calls (£0.02–£0.05 each)`,
    `  time  ~${e.hours} h${days} at ${e.slots} concurrent job slot(s), assuming ${minutesPerVideo} min per video`,
    '        (queue concurrency × worker processes; replace the assumption with the sample run’s',
    '        measured completedPerHour from GET /admin/library/ingest/status)',
  ].join('\n');
}

export function formatDistribution(rows: ReadonlyArray<{ category?: string | null }>): string {
  return categoryDistribution(rows)
    .map(([category, n]) => `  ${category.padEnd(24)} ${n}`)
    .join('\n');
}

export function formatErrors(errors: readonly RowError[], limit = 20): string {
  if (errors.length === 0) return 'No invalid rows.';
  const lines = errors
    .slice(0, limit)
    .map((e) => `  line ${e.line}: ${e.error}${e.url ? ` (${e.url})` : ''}`);
  if (errors.length > limit) lines.push(`  … and ${errors.length - limit} more`);
  return [`${errors.length} invalid row(s) — fix them in the manifest:`, ...lines].join('\n');
}

/** Picks up to n items without replacement using the injected random source. */
export function pickRandom<T>(items: readonly T[], n: number, random: () => number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (pool.length > 0 && out.length < n) {
    const [item] = pool.splice(Math.floor(random() * pool.length), 1);
    out.push(item as T);
  }
  return out;
}

/** Review report after a sample run: outcome counts, categories, 10 random items to look at. */
export function formatReviewReport(input: {
  studioUrl: string;
  rows: readonly ManifestRow[];
  runs: readonly RunStatus[];
  runIdByUrl: ReadonlyMap<string, string>;
  random: () => number;
  timedOut: boolean;
}): string {
  const byRun = new Map(input.runs.map((r) => [r.runId, r]));
  const outcome = (row: ManifestRow) => byRun.get(input.runIdByUrl.get(row.url) ?? '');
  const ok = input.rows.filter((r) => {
    const s = outcome(r)?.state;
    return s === 'SUCCEEDED' || s === 'DUPLICATE';
  });
  const failed = input.rows.filter((r) => outcome(r)?.state === 'FAILED');
  const pending = input.rows.length - ok.length - failed.length;
  const base = input.studioUrl.replace(/\/+$/, '');
  const review = pickRandom(ok, 10, input.random).map((row) => {
    const run = outcome(row);
    const ref = row.sourceRef ? ` [${row.sourceRef}]` : '';
    return `  ${base}/library/${run?.libraryItemId ?? '?'}  ${row.title ?? row.url}${ref}`;
  });
  const failures = failed.slice(0, 20).map((row) => {
    const reason = outcome(row)?.errorReason ?? 'unknown';
    return `  line ${row.line}: ${reason.slice(0, 200)} (${row.url})`;
  });
  return [
    `SAMPLE REVIEW — ${input.rows.length} submitted`,
    `  ingested ok: ${ok.length}   failed: ${failed.length}   still running: ${pending}${
      input.timedOut ? '  (stopped waiting; re-run with --report later)' : ''
    }`,
    'Category distribution (ingested):',
    formatDistribution(ok) || '  (none)',
    ...(failures.length ? ['Failures:', ...failures] : []),
    'Review these items (random 10):',
    ...(review.length ? review : ['  (none ingested)']),
    '',
    'Approve the sample (runbooks/corpus-ingestion.md step 3), then run the full ingestion with',
    'the same --state file and --apply (without --sample): accepted rows are skipped.',
  ].join('\n');
}
