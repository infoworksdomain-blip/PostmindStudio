import { ValidationError } from '../../errors';
import { QUEUES } from '../queue/queues';

// BACKLOG 12.2 — kill-switch rehearsal (playbook 11.4): engage a level through the Admin API, then
// time how long until no Studio job is active anywhere (read from the Prometheus queue gauge
// `studio_queue_jobs{queue,state="active"}` on /api/metrics). SLO: 60 s. Every rehearsal is timed;
// a breach is a launch blocker. Kept free of I/O so the timing logic is unit tested; the CLI
// wrapper is scripts/ops/rehearse-kill-switch.ts.

export const KILL_SWITCH_SLO_MS = 60_000;

export type RehearsalLevel = 'global' | 'workspace' | 'project' | 'provider' | 'platform';

/** Every level, least disruptive first (the order `staging-gate.ts --rehearse all` runs them). */
export const REHEARSAL_LEVELS: readonly RehearsalLevel[] = [
  'provider',
  'platform',
  'project',
  'workspace',
  'global',
];

export interface RehearsalPlan {
  level: RehearsalLevel;
  target?: string;
  reason: string;
}

/** Sum of `studio_queue_jobs{state="active"}` per queue from a Prometheus text exposition. */
export function activeJobsByQueue(metricsText: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of metricsText.split('\n')) {
    if (!line.startsWith('studio_queue_jobs{')) continue;
    const match = /^studio_queue_jobs\{([^}]*)\}\s+([0-9.eE+-]+)\s*$/.exec(line.trim());
    if (!match) continue;
    const [, rawLabels = '', rawValue = ''] = match;
    const labels = Object.fromEntries(
      [...rawLabels.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]),
    );
    if (labels.state !== 'active' || !labels.queue) continue;
    out[labels.queue] = (out[labels.queue] ?? 0) + Number(rawValue);
  }
  return out;
}

export function totalActive(byQueue: Record<string, number>): number {
  return Object.values(byQueue).reduce((a, b) => a + b, 0);
}

export interface DrainDeps {
  /** Returns the /api/metrics body. */
  scrape: () => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface DrainResult {
  drained: boolean;
  elapsedMs: number;
  withinSlo: boolean;
  samples: Array<{ atMs: number; active: Record<string, number> }>;
}

/**
 * Poll until every queue reports zero active jobs for `stableSamples` consecutive scrapes (so a
 * job picked up between scrapes can't produce a false "drained"), or until `timeoutMs`.
 */
export async function waitForDrain(
  deps: DrainDeps,
  opts: { startedAt: number; intervalMs?: number; timeoutMs?: number; stableSamples?: number },
): Promise<DrainResult> {
  const intervalMs = opts.intervalMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? KILL_SWITCH_SLO_MS * 3;
  const stableSamples = opts.stableSamples ?? 2;
  if (intervalMs <= 0 || timeoutMs <= 0 || stableSamples < 1) {
    throw new ValidationError('Invalid drain options');
  }
  const samples: DrainResult['samples'] = [];
  let zeroStreak = 0;
  let firstZeroAt: number | undefined;
  for (;;) {
    const active = activeJobsByQueue(await deps.scrape());
    const atMs = deps.now() - opts.startedAt;
    samples.push({ atMs, active });
    if (totalActive(active) === 0) {
      zeroStreak += 1;
      firstZeroAt ??= atMs;
    } else {
      zeroStreak = 0;
      firstZeroAt = undefined;
    }
    if (zeroStreak >= stableSamples && firstZeroAt !== undefined) {
      return {
        drained: true,
        elapsedMs: firstZeroAt,
        withinSlo: firstZeroAt <= KILL_SWITCH_SLO_MS,
        samples,
      };
    }
    if (atMs >= timeoutMs) return { drained: false, elapsedMs: atMs, withinSlo: false, samples };
    await deps.sleep(intervalMs);
  }
}

export function parsePlan(argv: string[]): RehearsalPlan {
  const [level, target] = argv;
  if (!REHEARSAL_LEVELS.includes(level as RehearsalLevel)) {
    throw new ValidationError(`level must be one of ${REHEARSAL_LEVELS.join(', ')}`);
  }
  if (level !== 'global' && !target) throw new ValidationError(`${level} needs a target id`);
  return {
    level: level as RehearsalLevel,
    target: level === 'global' ? undefined : target,
    reason: `Kill-switch rehearsal (${level}${target ? ` ${target}` : ''}) — playbook 11.4`,
  };
}

export function formatReport(plan: RehearsalPlan, result: DrainResult): string {
  const secs = (result.elapsedMs / 1000).toFixed(1);
  const verdict = !result.drained
    ? `FAIL — queues did not drain (${secs}s)`
    : result.withinSlo
      ? `PASS — drained in ${secs}s (SLO 60s)`
      : `FAIL — drained in ${secs}s, over the 60s SLO`;
  const lines = [
    `Kill-switch rehearsal: level=${plan.level}${plan.target ? ` target=${plan.target}` : ''}`,
    verdict,
    'Samples (s → active jobs by queue):',
    ...result.samples.map(
      (s) => `  ${(s.atMs / 1000).toFixed(1).padStart(6)}  ${JSON.stringify(s.active)}`,
    ),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------- scoped levels (Phase 14.6)
//
// The queue gauge is not labelled by organisation, project, provider or platform, so the scoped
// levels are measured from the staging database instead (read-only): the probe counts in-scope
// work that STARTED after the switch was engaged (provider_jobs.startedAt for workspace, project
// and provider; video_publications moving to PUBLISHING/PUBLISHED for platform) and what is
// still in flight. "Halted" = nothing new started for `quietMs` at the end of the observation
// window; the time to halt is when the last in-scope start happened (0 when none did). Work that
// was already running when the switch was engaged finishes normally (runbooks/kill-switch.md),
// so in-flight work only has to reach 0 where `requireIdle` is set (platform: the publish queue).

export interface ScopeObservation {
  /** In-scope jobs or publications that started after the switch was engaged. */
  startedSinceEngage: number;
  /** When the latest of those started (epoch ms), or null when none did. */
  lastStartedAt: number | null;
  /** In-scope work still in flight (provider jobs PENDING/RUNNING; publications PUBLISHING). */
  inFlight: number;
  /** Platform level: studio_queue_jobs{queue="studio-publish",state="active"} at this moment. */
  publishQueueActive?: number;
}

export interface HaltResult {
  halted: boolean;
  /** ms from engaging to the last in-scope start (0 when nothing started after engaging). */
  elapsedMs: number;
  withinSlo: boolean;
  observedMs: number;
  samples: HaltSample[];
}

export interface HaltSample {
  atMs: number;
  startedSinceEngage: number;
  /** The latest in-scope start, in ms after engaging (null when none). */
  lastStartMs: number | null;
  inFlight: number;
  publishQueueActive?: number;
}

export interface HaltDeps {
  probe: () => Promise<ScopeObservation>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Observe a scoped level for `observeMs` (default SLO + 30 s) and judge it against the SLO. */
export async function observeHalt(
  deps: HaltDeps,
  opts: {
    startedAt: number;
    intervalMs?: number;
    observeMs?: number;
    quietMs?: number;
    requireIdle?: boolean;
  },
): Promise<HaltResult> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const quietMs = opts.quietMs ?? 30_000;
  const observeMs = opts.observeMs ?? KILL_SWITCH_SLO_MS + quietMs;
  if (intervalMs <= 0 || quietMs <= 0 || observeMs < quietMs) {
    throw new ValidationError('Invalid halt observation options');
  }
  const samples: HaltResult['samples'] = [];
  for (;;) {
    const { lastStartedAt, ...rest } = await deps.probe();
    const atMs = deps.now() - opts.startedAt;
    const lastStartMs = lastStartedAt === null ? null : Math.max(0, lastStartedAt - opts.startedAt);
    samples.push({ atMs, lastStartMs, ...rest });
    if (atMs >= observeMs) break;
    await deps.sleep(intervalMs);
  }
  const last = samples[samples.length - 1] as HaltSample;
  const elapsedMs = last.lastStartMs ?? 0;
  const quiet = last.atMs - elapsedMs >= quietMs;
  const idle = !opts.requireIdle || last.inFlight === 0;
  const halted = quiet && idle;
  return {
    halted,
    elapsedMs,
    withinSlo: halted && elapsedMs <= KILL_SWITCH_SLO_MS,
    observedMs: last.atMs,
    samples,
  };
}

/** Active publish jobs from a Prometheus exposition (the platform level's queue signal). */
export function publishQueueActive(metricsText: string): number {
  return activeJobsByQueue(metricsText)[QUEUES.publish] ?? 0;
}

export function formatHaltReport(plan: RehearsalPlan, result: HaltResult): string {
  const secs = (result.elapsedMs / 1000).toFixed(1);
  const observed = (result.observedMs / 1000).toFixed(0);
  const last = result.samples[result.samples.length - 1];
  const verdict = !result.halted
    ? `FAIL — work in scope still starting${last && last.inFlight > 0 ? ` or in flight (${last.inFlight})` : ''} after ${observed}s`
    : result.withinSlo
      ? `PASS — last in-scope start ${secs}s after engaging (SLO 60s), quiet until ${observed}s`
      : `FAIL — last in-scope start ${secs}s after engaging, over the 60s SLO`;
  return [
    `Kill-switch rehearsal: level=${plan.level}${plan.target ? ` target=${plan.target}` : ''}`,
    verdict,
    'Samples (s → started since engage / in flight / last start s):',
    ...result.samples.map((s) => {
      const lastStart = s.lastStartMs === null ? '-' : (s.lastStartMs / 1000).toFixed(1);
      const queue =
        s.publishQueueActive === undefined ? '' : ` publishActive=${s.publishQueueActive}`;
      return `  ${(s.atMs / 1000).toFixed(1).padStart(6)}  started=${s.startedSinceEngage} inFlight=${s.inFlight} lastStart=${lastStart}${queue}`;
    }),
  ].join('\n');
}
