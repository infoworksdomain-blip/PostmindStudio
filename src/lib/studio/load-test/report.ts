// 20.29 load-test harness — the numbers a run reports, as pure functions (tested), so the report
// says the same thing whichever machine produced it.

export interface ProjectOutcome {
  projectId: string;
  organisationId: string;
  /** ms since epoch the run was enqueued. */
  startedAt: number;
  /** ms since epoch the project reached a terminal state (undefined = still running at the end). */
  finishedAt?: number;
  finalState: string;
  errorReason?: string | null;
  costPence: number;
  /** ms from start to the first provider-wait note ("queued, starting soon"), if any. */
  firstWaitAt?: number;
}

export interface Distribution {
  count: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentile (p in 0–100) of a list; 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

export function distribution(values: readonly number[]): Distribution {
  const total = values.reduce((sum, v) => sum + v, 0);
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length ? Math.max(...values) : 0,
    mean: values.length ? total / values.length : 0,
  };
}

export const READY_STATES: readonly string[] = ['READY_FOR_REVIEW', 'APPROVED'];

export interface OrganisationSummary {
  organisationId: string;
  projects: number;
  ready: number;
  timeToReadyMs: Distribution;
}

export interface RunSummary {
  projects: number;
  ready: number;
  byState: Record<string, number>;
  timeToReadyMs: Distribution;
  /** Projects / hour from the first start to the last finish. */
  throughputPerHour: number;
  byOrganisation: OrganisationSummary[];
  /**
   * Fairness: the slowest light organisation's median time-to-ready divided by the fastest one's
   * (1 = perfectly even). "Light" = organisations that started no more than the median number.
   */
  lightOrganisationSpread: number;
  /** Failure reasons (prefix before ':'), counted. */
  failureClasses: Record<string, number>;
  costPence: Distribution;
}

function count<T extends string>(items: readonly T[]): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {});
}

export function failureClass(reason: string | null | undefined): string {
  if (!reason) return 'unknown';
  const head = reason.split(':')[0]?.trim() ?? 'unknown';
  return head.length > 60 ? `${head.slice(0, 60)}…` : head;
}

export function summarise(outcomes: readonly ProjectOutcome[]): RunSummary {
  const ready = outcomes.filter((o) => READY_STATES.includes(o.finalState) && o.finishedAt);
  const times = ready.map((o) => (o.finishedAt ?? 0) - o.startedAt);
  const firstStart = Math.min(...outcomes.map((o) => o.startedAt));
  const lastFinish = Math.max(...outcomes.map((o) => o.finishedAt ?? o.startedAt));
  const hours = Math.max(1, lastFinish - firstStart) / 3_600_000;
  const orgIds = [...new Set(outcomes.map((o) => o.organisationId))];
  const byOrganisation = orgIds.map((organisationId) => {
    const mine = outcomes.filter((o) => o.organisationId === organisationId);
    const mineReady = mine.filter((o) => READY_STATES.includes(o.finalState) && o.finishedAt);
    return {
      organisationId,
      projects: mine.length,
      ready: mineReady.length,
      timeToReadyMs: distribution(mineReady.map((o) => (o.finishedAt ?? 0) - o.startedAt)),
    };
  });
  const medianLoad = percentile(
    byOrganisation.map((o) => o.projects),
    50,
  );
  const lightMedians = byOrganisation
    .filter((o) => o.projects <= medianLoad && o.ready > 0)
    .map((o) => o.timeToReadyMs.p50);
  const failed = outcomes.filter((o) => !READY_STATES.includes(o.finalState));
  return {
    projects: outcomes.length,
    ready: ready.length,
    byState: count(outcomes.map((o) => o.finalState)),
    timeToReadyMs: distribution(times),
    throughputPerHour: outcomes.length ? ready.length / hours : 0,
    byOrganisation,
    lightOrganisationSpread:
      lightMedians.length > 1
        ? Math.max(...lightMedians) / Math.max(1, Math.min(...lightMedians))
        : 1,
    failureClasses: count(failed.map((o) => failureClass(o.errorReason ?? o.finalState))),
    costPence: distribution(outcomes.map((o) => o.costPence)),
  };
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/** A Markdown section for one scenario (the runbook's results file collects them). */
export function renderMarkdown(input: {
  title: string;
  timeScale: number;
  summary: RunSummary;
  extra?: Readonly<Record<string, string | number>>;
}): string {
  const { summary: s, timeScale } = input;
  // Simulated provider latencies were multiplied by timeScale: divide to get real-time figures.
  const real = (ms: number) => seconds(ms / timeScale);
  const lines = [
    `### ${input.title}`,
    '',
    `| Measure | Value |`,
    `| --- | --- |`,
    `| Projects | ${s.projects} (${s.ready} ready) |`,
    `| States | ${Object.entries(s.byState)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')} |`,
    `| Time to ready p50 / p95 / max (real-time equivalent) | ${real(s.timeToReadyMs.p50)} / ${real(s.timeToReadyMs.p95)} / ${real(s.timeToReadyMs.max)} |`,
    `| Throughput (real-time equivalent) | ${(s.throughputPerHour * timeScale).toFixed(1)} videos / hour |`,
    `| Light-organisation spread (fairness, 1 = even) | ${s.lightOrganisationSpread.toFixed(2)} |`,
    `| Failure classes | ${
      Object.entries(s.failureClasses)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    } |`,
    `| Cost per video p50 / max | ${s.costPence.p50}p / ${s.costPence.max}p |`,
    ...Object.entries(input.extra ?? {}).map(([k, v]) => `| ${k} | ${v} |`),
    '',
  ];
  return lines.join('\n');
}
