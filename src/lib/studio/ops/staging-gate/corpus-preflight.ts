import { DEFAULT_ORG_DAILY_CAP_PENCE, costCapsFromEnv } from '../../cost/caps';
import { COST_PER_VIDEO_PENCE, estimate } from '../../library/corpus-report';
import {
  assertAllowedS3Source,
  isS3Url,
  parseCorpusBuckets,
  parseS3Url,
} from '../../library/corpus-source';
import type { ManifestRow, RowError } from '../../library/corpus-manifest';
import { concurrencyFor, MAX_LIBRARY_CONCURRENCY } from '../../queue/worker-host';
import { QUEUES } from '../../queue/queues';
import { libraryPlanTier } from '../../services/library';
import type { PlanTier } from '../../providers/router';
import type { GateSection, Verdict } from './report';

// Phase 14.9 — corpus pre-flight (pure; unit tested). `ingest-corpus.ts <manifest> --preflight`
// gathers the inputs (env of the library worker, the manifest, bucket probes) and this module
// turns them into PASS / WARN / FAIL checks before a sample (9.2) or full (9.3) run.
// Run it with the SAME env as the library workers (e.g. inside the worker-library container), so
// the tier, concurrency and bucket settings it reads are the ones the workers use.

export type CheckLevel = 'PASS' | 'WARN' | 'FAIL';

export interface PreflightCheck {
  name: string;
  level: CheckLevel;
  detail: string;
}

/** Runbook throughput table: fewer than 8 slots makes a 50k run take weeks. */
export const MIN_FULL_RUN_SLOTS = 8;
/** Above 16 slots, check provider rate limits first (corpus-ingestion.md). */
export const RATE_LIMIT_WARN_SLOTS = 16;
/** Probe up to this many s3:// sources with a HEAD. */
export const MAX_S3_PROBES = 20;

export interface PreflightInput {
  mode: 'sample' | 'full';
  env: Record<string, string | undefined>;
  workers: number;
  minutesPerVideo: number;
  rows: ManifestRow[];
  errors: RowError[];
  /** Result of listing categories through the admin API (API + token reachable). */
  categories: { ok: boolean; detail: string };
  /** Write + delete probe in S3_BUCKET_LIBRARY (library/staging/). */
  libraryBucket: { ok: boolean; detail: string } | null;
  /** HEAD results for the sampled s3:// sources. */
  s3Probes: Array<{ url: string; ok: boolean; detail: string }>;
}

function tierCheck(input: PreflightInput): PreflightCheck {
  let tier: PlanTier;
  try {
    tier = libraryPlanTier(input.env);
  } catch (err) {
    return { name: 'Caps tier', level: 'FAIL', detail: (err as Error).message };
  }
  const caps = costCapsFromEnv(input.env);
  const daily = caps.orgDailyPenceByTier[tier] ?? DEFAULT_ORG_DAILY_CAP_PENCE[tier];
  const detail = `STUDIO_LIBRARY_PLAN_TIER=${tier} (org daily cap ${daily === undefined ? 'none' : `£${(daily / 100).toFixed(0)}`})`;
  if (tier === 'ENTERPRISE') return { name: 'Caps tier', level: 'PASS', detail };
  return {
    name: 'Caps tier',
    level: input.mode === 'full' ? 'FAIL' : 'WARN',
    detail: `${detail}. The full run (9.3) needs STUDIO_LIBRARY_PLAN_TIER=ENTERPRISE on the library workers.`,
  };
}

function concurrencyCheck(input: PreflightInput): PreflightCheck[] {
  const perWorker = concurrencyFor(QUEUES.library, input.env);
  const slots = perWorker * input.workers;
  const est = estimate(input.rows.length, {
    minutesPerVideo: input.minutesPerVideo,
    queueConcurrency: perWorker,
    workers: input.workers,
  });
  const spendPerDayHigh = Math.round(
    (slots * (60 / input.minutesPerVideo) * 24 * COST_PER_VIDEO_PENCE.high) / 100,
  );
  const out: PreflightCheck[] = [];
  const detail = `STUDIO_LIBRARY_CONCURRENCY=${perWorker} (max ${MAX_LIBRARY_CONCURRENCY}) × ${input.workers} worker(s) = ${slots} slot(s); ${est.videos} videos ≈ ${est.hours} h at ${input.minutesPerVideo} min each; up to ~£${spendPerDayHigh}/day`;
  if (input.mode === 'full' && slots < MIN_FULL_RUN_SLOTS) {
    out.push({
      name: 'Worker concurrency',
      level: 'WARN',
      detail: `${detail}. Fewer than ${MIN_FULL_RUN_SLOTS} slots: raise STUDIO_LIBRARY_CONCURRENCY or run more library workers.`,
    });
  } else if (slots > RATE_LIMIT_WARN_SLOTS) {
    out.push({
      name: 'Worker concurrency',
      level: 'WARN',
      detail: `${detail}. Above ${RATE_LIMIT_WARN_SLOTS} slots: confirm the Claude / AssemblyAI / OpenAI rate limits first.`,
    });
  } else out.push({ name: 'Worker concurrency', level: 'PASS', detail });
  return out;
}

function manifestCheck(input: PreflightInput): PreflightCheck {
  const bad = input.errors.length;
  const detail = `${input.rows.length} valid row(s), ${bad} invalid${bad ? ` (first: line ${input.errors[0]?.line}: ${input.errors[0]?.error})` : ''}`;
  if (input.rows.length === 0) return { name: 'Manifest', level: 'FAIL', detail };
  if (bad === 0) return { name: 'Manifest', level: 'PASS', detail };
  return {
    name: 'Manifest',
    level: input.mode === 'full' ? 'FAIL' : 'WARN',
    detail: `${detail}. A full run refuses to start while any row is invalid.`,
  };
}

function bucketChecks(input: PreflightInput): PreflightCheck[] {
  const out: PreflightCheck[] = [];
  out.push(
    input.libraryBucket
      ? {
          name: 'Library bucket (S3_BUCKET_LIBRARY)',
          level: input.libraryBucket.ok ? 'PASS' : 'FAIL',
          detail: input.libraryBucket.detail,
        }
      : {
          name: 'Library bucket (S3_BUCKET_LIBRARY)',
          level: 'FAIL',
          detail: 'S3_BUCKET_LIBRARY is not set',
        },
  );
  const s3Rows = input.rows.filter((r) => isS3Url(r.url));
  if (s3Rows.length === 0) return out;
  let allowed;
  try {
    allowed = parseCorpusBuckets(input.env.STUDIO_CORPUS_S3_BUCKETS);
  } catch (err) {
    out.push({ name: 'Corpus bucket allow-list', level: 'FAIL', detail: (err as Error).message });
    return out;
  }
  const refused = s3Rows.filter((r) => {
    try {
      assertAllowedS3Source(parseS3Url(r.url), allowed);
      return false;
    } catch {
      return true;
    }
  });
  out.push({
    name: 'Corpus bucket allow-list (STUDIO_CORPUS_S3_BUCKETS)',
    level: refused.length ? 'FAIL' : 'PASS',
    detail: refused.length
      ? `${refused.length} of ${s3Rows.length} s3:// row(s) are outside the allow-list (first: line ${refused[0]?.line})`
      : `${s3Rows.length} s3:// row(s), all allow-listed`,
  });
  const failed = input.s3Probes.filter((p) => !p.ok);
  out.push({
    name: 'Corpus bucket read access',
    level: input.s3Probes.length === 0 ? 'WARN' : failed.length ? 'FAIL' : 'PASS',
    detail:
      input.s3Probes.length === 0
        ? 'no s3:// source was probed'
        : failed.length
          ? `${failed.length}/${input.s3Probes.length} HEAD probes failed (first: ${failed[0]?.url}: ${failed[0]?.detail})`
          : `${input.s3Probes.length} s3:// source(s) readable (HEAD)`,
  });
  return out;
}

export function evaluatePreflight(input: PreflightInput): PreflightCheck[] {
  return [
    {
      name: 'Admin API (GET /library/categories)',
      level: input.categories.ok ? 'PASS' : 'FAIL',
      detail: input.categories.detail,
    },
    tierCheck(input),
    ...concurrencyCheck(input),
    manifestCheck(input),
    ...bucketChecks(input),
  ];
}

/** Rows to probe: an even spread of the s3:// sources, at most MAX_S3_PROBES. */
export function s3ProbeRows(rows: readonly ManifestRow[], max = MAX_S3_PROBES): ManifestRow[] {
  const s3 = rows.filter((r) => isS3Url(r.url));
  if (s3.length <= max) return s3;
  const step = s3.length / max;
  return Array.from({ length: max }, (_, i) => s3[Math.floor(i * step)] as ManifestRow);
}

export function preflightVerdict(checks: readonly PreflightCheck[]): Verdict {
  return checks.some((c) => c.level === 'FAIL') ? 'FAIL' : 'PASS';
}

export function formatPreflight(
  checks: readonly PreflightCheck[],
  mode: 'sample' | 'full',
): string {
  return [
    `Corpus pre-flight (${mode === 'full' ? 'full run 9.3' : 'sample run 9.2'}):`,
    ...checks.map((c) => `  [${c.level}] ${c.name}: ${c.detail}`),
    preflightVerdict(checks) === 'PASS'
      ? 'PRE-FLIGHT PASSED — review the WARN lines, then run the command in runbooks/corpus-ingestion.md.'
      : 'PRE-FLIGHT FAILED — fix the FAIL lines before submitting anything.',
  ].join('\n');
}

export function preflightSections(output: string, exitCode: number): GateSection[] {
  const text = output
    .split('\n')
    .filter((l) => !/^npm (warn|notice)/.test(l.trim()))
    .join('\n')
    .trim();
  return [
    {
      title: 'ingest-corpus.ts --preflight',
      verdict: exitCode === 0 ? 'PASS' : 'FAIL',
      lines: ['```', text || '(no output)', '```'],
    },
    {
      title: 'Next (runbooks/corpus-ingestion.md)',
      lines: [
        '1. Sample run: `ingest-corpus.ts <manifest> --sample 100 --seed 7 --apply`.',
        '2. Operator review with the checklist in runbooks/corpus-ingestion.md; record approval in PROGRESS.md.',
        '3. Re-run this pre-flight in full mode (no --sample), then the full run.',
      ],
    },
  ];
}
