import { ValidationError } from '../../errors';

// BACKLOG 12.2 — kill-switch rehearsal (playbook 11.4): engage a level through the Admin API, then
// time how long until no Studio job is active anywhere (read from the Prometheus queue gauge
// `studio_queue_jobs{queue,state="active"}` on /api/metrics). SLO: 60 s. Every rehearsal is timed;
// a breach is a launch blocker. Kept free of I/O so the timing logic is unit tested; the CLI
// wrapper is scripts/ops/rehearse-kill-switch.ts.

export const KILL_SWITCH_SLO_MS = 60_000;

export type RehearsalLevel = 'global' | 'workspace' | 'project' | 'provider';

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
  const levels: RehearsalLevel[] = ['global', 'workspace', 'project', 'provider'];
  if (!levels.includes(level as RehearsalLevel)) {
    throw new ValidationError(`level must be one of ${levels.join(', ')}`);
  }
  if (level !== 'global' && !target) throw new ValidationError(`${level} needs a target id`);
  return {
    level: level as RehearsalLevel,
    target: level === 'global' ? undefined : target,
    reason: `Kill-switch rehearsal (${level}${target ? ` ${target}` : ''}) — playbook 11.4`,
  };
}

/**
 * BACKLOG 15.D6: engaging the global level answers 202 { pending: { requestId, ... } } until a
 * second staff member confirms it. Returns the request id, or undefined when the switch was set
 * directly (200: break-glass, or already engaged).
 */
export function pendingGlobalRequestId(status: number, body: unknown): string | undefined {
  if (status !== 202) return undefined;
  const requestId = (body as { pending?: { requestId?: unknown } } | null)?.pending?.requestId;
  if (typeof requestId !== 'string' || requestId === '') {
    throw new ValidationError('202 from the kill-switch PUT without a pending requestId');
  }
  return requestId;
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
