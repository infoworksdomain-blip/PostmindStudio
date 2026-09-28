import { ValidationError } from '../../../errors';
import type { K6Mode } from './args';
import { combineVerdicts, type GateSection, type Verdict } from './report';

// Phase 14.5 — k6 smoke / full run evaluation (pure). The CLI runs
//   k6 run --summary-export <file> -e RUN_MODE=<mode> --include-system-env-vars load-test/k6/studio-api.js
// (options reference: https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/ —
// `--summary-export <filename>`, `--env/-e`, `--include-system-env-vars`), so the staging token
// reaches the script through the process environment, never the command line.
//
// The summary-export JSON has `metrics.<name>` with the Trend stats listed in the script's
// `summaryTrendStats` (avg, p(50), p(95), p(99), max) and, for Rate metrics, `value` (the rate)
// plus `passes` / `fails`. k6's own threshold booleans are not relied on: the thresholds below
// are re-evaluated from the values, and k6's exit code (99 = thresholds crossed) is recorded too.

export interface Threshold {
  metric: string;
  stat: string;
  op: '<' | '>';
  limit: number;
  source: string;
  /** Absent metric = not applicable (e.g. write latency when WRITES is off) instead of FAIL. */
  optional?: boolean;
}

/** Mirrors `options.thresholds` in load-test/k6/studio-api.js. */
export const K6_THRESHOLDS: readonly Threshold[] = [
  { metric: 'http_req_duration', stat: 'p(95)', op: '<', limit: 300, source: 'spec 17.1' },
  { metric: 'http_req_duration', stat: 'p(99)', op: '<', limit: 2000, source: 'Engagement 16.4' },
  { metric: 'studio_read_latency', stat: 'p(95)', op: '<', limit: 300, source: 'spec 17.1' },
  {
    metric: 'studio_write_latency',
    stat: 'p(95)',
    op: '<',
    limit: 500,
    source: 'Engagement 16.4',
    optional: true,
  },
  { metric: 'studio_errors', stat: 'rate', op: '<', limit: 0.001, source: 'Engagement 16.4' },
  { metric: 'checks', stat: 'rate', op: '>', limit: 0.999, source: 'Engagement 16.4' },
];

/** Spec 17.2 throughput targets (per day across all orgs). */
export const THROUGHPUT_TARGETS_PER_DAY = { projects: 500, publications: 4000 } as const;

/** k6 exits 99 when a threshold is crossed (k6 errext exit codes). */
export const K6_THRESHOLDS_FAILED_EXIT = 99;

export type K6Metrics = Record<string, Record<string, number>>;

/** Pulls the numeric stats out of a --summary-export document. */
export function parseSummaryExport(raw: unknown): K6Metrics {
  const metrics = (raw as { metrics?: unknown } | null)?.metrics;
  if (!metrics || typeof metrics !== 'object') {
    throw new ValidationError('k6 summary export has no metrics object');
  }
  const out: K6Metrics = {};
  for (const [name, value] of Object.entries(metrics as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const stats: Record<string, number> = {};
    for (const [stat, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) stats[stat] = v;
    }
    // Rate metrics export their rate as `value`; expose it as `rate` for the threshold table.
    if (stats.rate === undefined && stats.value !== undefined && 'passes' in (value as object)) {
      stats.rate = stats.value;
    }
    out[name] = stats;
  }
  return out;
}

export interface ThresholdResult extends Threshold {
  actual: number | null;
  verdict: Verdict | 'N/A';
}

export function evaluateThresholds(
  metrics: K6Metrics,
  thresholds: readonly Threshold[] = K6_THRESHOLDS,
): ThresholdResult[] {
  return thresholds.map((t) => {
    const actual = metrics[t.metric]?.[t.stat];
    if (actual === undefined) {
      return { ...t, actual: null, verdict: t.optional ? 'N/A' : 'FAIL' };
    }
    const ok = t.op === '<' ? actual < t.limit : actual > t.limit;
    return { ...t, actual, verdict: ok ? 'PASS' : 'FAIL' };
  });
}

/** `studio_jobs_total{job,outcome="succeeded"}` per job from a Prometheus exposition. */
export function succeededJobs(metricsText: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of metricsText.split('\n')) {
    const match = /^studio_jobs_total\{([^}]*)\}\s+([0-9.eE+-]+)\s*$/.exec(line.trim());
    if (!match) continue;
    const labels = Object.fromEntries(
      [...(match[1] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]),
    );
    if (labels.outcome !== 'succeeded' || !labels.job) continue;
    out[labels.job] = (out[labels.job] ?? 0) + Number(match[2]);
  }
  return out;
}

export interface Throughput {
  elapsedMs: number;
  perHour: Record<string, number>;
  publicationsPerDay: number;
  projectsPerDay: number;
}

/** Job completions per hour between two scrapes (a counter reset counts from zero). */
export function throughputBetween(
  before: Record<string, number>,
  after: Record<string, number>,
  elapsedMs: number,
): Throughput {
  if (elapsedMs <= 0) throw new ValidationError('elapsedMs must be positive');
  const hours = elapsedMs / 3_600_000;
  const perHour: Record<string, number> = {};
  for (const [job, n] of Object.entries(after)) {
    const prev = before[job] ?? 0;
    const delta = n >= prev ? n - prev : n;
    perHour[job] = Math.round((delta / hours) * 10) / 10;
  }
  return {
    elapsedMs,
    perHour,
    publicationsPerDay: Math.round((perHour['publish-video'] ?? 0) * 24),
    projectsPerDay: Math.round((perHour['plan-project'] ?? 0) * 24),
  };
}

function fmt(n: number | null, stat: string): string {
  if (n === null) return '—';
  return stat === 'rate' ? n.toFixed(4) : `${n.toFixed(1)} ms`;
}

export function k6Sections(input: {
  mode: K6Mode;
  exitCode: number;
  results: ThresholdResult[];
  metrics: K6Metrics;
  throughput?: Throughput;
}): { verdict: Verdict; sections: GateSection[] } {
  const thresholdVerdict = combineVerdicts(
    input.results.filter((r) => r.verdict !== 'N/A').map((r) => r.verdict as Verdict),
  );
  const k6Verdict: Verdict = input.exitCode === 0 ? 'PASS' : 'FAIL';
  const sections: GateSection[] = [
    {
      title: `Thresholds (${input.mode})`,
      verdict: thresholdVerdict,
      lines: [
        '| Metric | Stat | Target | Actual | Source | Result |',
        '| --- | --- | --- | --- | --- | --- |',
        ...input.results.map(
          (r) =>
            `| ${r.metric} | ${r.stat} | ${r.op} ${r.stat === 'rate' ? r.limit : `${r.limit} ms`} | ${fmt(r.actual, r.stat)} | ${r.source} | ${r.verdict} |`,
        ),
      ],
    },
    {
      title: 'k6 exit status',
      verdict: k6Verdict,
      lines: [
        input.exitCode === 0
          ? 'k6 exited 0 (every threshold in the script held).'
          : input.exitCode === K6_THRESHOLDS_FAILED_EXIT
            ? 'k6 exited 99: at least one threshold in the script was crossed.'
            : `k6 exited ${input.exitCode}: the run itself failed (setup, target not ready or a script error).`,
        `Requests: ${input.metrics.http_reqs?.count ?? 0} at ${(input.metrics.http_reqs?.rate ?? 0).toFixed(1)}/s; iterations: ${input.metrics.iterations?.count ?? 0}.`,
      ],
    },
  ];
  if (input.throughput) {
    const t = input.throughput;
    sections.push({
      title: 'Queue throughput during the run (spec 17.2, informational)',
      lines: [
        `Measured from studio_jobs_total over ${(t.elapsedMs / 60_000).toFixed(1)} min.`,
        `Publications: ${t.publicationsPerDay}/day at this rate (target ${THROUGHPUT_TARGETS_PER_DAY.publications}/day).`,
        `Projects planned: ${t.projectsPerDay}/day at this rate (target ${THROUGHPUT_TARGETS_PER_DAY.projects}/day).`,
        'The read-API load test does not generate or publish; drive real generations and scheduled',
        'posts alongside the full run to measure the queues against the targets.',
        ...Object.entries(t.perHour).map(([job, n]) => `- ${job}: ${n}/h`),
      ],
    });
  }
  return { verdict: combineVerdicts([thresholdVerdict, k6Verdict]), sections };
}

export const K6_SCRIPT = 'load-test/k6/studio-api.js';
export const K6_INSTALL_HINT =
  'k6 is not installed or not on PATH. Install it (https://grafana.com/docs/k6/latest/set-up/install-k6/) or set K6_BIN to the binary.';

/** The environment the k6 script needs (read by the script through __ENV). */
export const K6_REQUIRED_ENV = ['BASE_URL', 'STUDIO_TOKEN'] as const;

export function missingK6Env(env: Record<string, string | undefined>): string[] {
  return K6_REQUIRED_ENV.filter((name) => !env[name]?.trim());
}

/** Arguments for `k6 run`; secrets stay in the process environment, not on the command line. */
export function k6RunArgs(mode: K6Mode, summaryFile: string, script = K6_SCRIPT): string[] {
  return [
    'run',
    '--summary-export',
    summaryFile,
    '--include-system-env-vars',
    '-e',
    `RUN_MODE=${mode}`,
    script,
  ];
}
