import { ConfigurationError, ValidationError } from '../../../errors';
import { PLATFORMS } from '../../services/catalog';
import { PROVIDER_IDS } from '../../system-flags';
import {
  formatHaltReport,
  formatReport,
  REHEARSAL_LEVELS,
  type DrainResult,
  type HaltResult,
  type RehearsalLevel,
  type RehearsalPlan,
} from '../rehearsal';
import { IMAGE_TAG } from './args';
import type { GateSection, Verdict } from './report';

// Phase 14.6 — kill-switch (all five levels) and rollback rehearsal logic (pure; unit tested).
// The CLI is scripts/ops/staging-gate.ts --rehearse; runbooks/kill-switch.md + rollback.md.

type ScopedLevel = Exclude<RehearsalLevel, 'global'>;

/** Env fallbacks for the targets (GitHub Actions inputs / repository variables). */
export const TARGET_ENV: Record<ScopedLevel, string> = {
  workspace: 'REHEARSE_WORKSPACE_ID',
  project: 'REHEARSE_PROJECT_ID',
  provider: 'REHEARSE_PROVIDER',
  platform: 'REHEARSE_PLATFORM',
};

/** Defaults where a safe one exists: Runway fails over to Luma; TikTok is the test platform. */
const DEFAULT_TARGET: Partial<Record<ScopedLevel, string>> = {
  provider: 'runway',
  platform: 'tiktok',
};

export interface KillSwitchPlanSet {
  plans: RehearsalPlan[];
  skipped: Array<{ level: RehearsalLevel; reason: string }>;
}

export function buildKillSwitchPlans(
  levels: readonly RehearsalLevel[],
  targets: Partial<Record<ScopedLevel, string>>,
  env: Record<string, string | undefined> = {},
): KillSwitchPlanSet {
  const out: KillSwitchPlanSet = { plans: [], skipped: [] };
  const ordered = REHEARSAL_LEVELS.filter((l) => levels.includes(l));
  for (const level of ordered) {
    if (level === 'global') {
      out.plans.push({ level, reason: 'Kill-switch rehearsal (global) — staging gate 14.6' });
      continue;
    }
    const target = targets[level] ?? env[TARGET_ENV[level]]?.trim() ?? DEFAULT_TARGET[level];
    if (!target) {
      out.skipped.push({
        level,
        reason: `no target: pass --${level} <id> or set ${TARGET_ENV[level]}`,
      });
      continue;
    }
    if (level === 'provider' && !(PROVIDER_IDS as readonly string[]).includes(target)) {
      throw new ValidationError(`Unknown provider id "${target}"`);
    }
    if (level === 'platform' && !(PLATFORMS as readonly string[]).includes(target)) {
      throw new ValidationError(`Unknown platform "${target}" (one of ${PLATFORMS.join(', ')})`);
    }
    out.plans.push({
      level,
      target,
      reason: `Kill-switch rehearsal (${level} ${target}) — staging gate 14.6`,
    });
  }
  return out;
}

export type LevelOutcome =
  | { plan: RehearsalPlan; kind: 'drain'; result: DrainResult }
  | {
      plan: RehearsalPlan;
      kind: 'halt';
      result: HaltResult;
      /** In-scope starts in the LOAD_WINDOW before engaging (proof the scope was under load). */
      activityBefore: number;
    }
  | { plan: RehearsalPlan; kind: 'unmeasured'; note: string }
  | { plan: RehearsalPlan; kind: 'error'; message: string };

/** How far back the rehearsal looks for in-scope work before engaging. */
export const LOAD_WINDOW_MS = 5 * 60_000;

/**
 * A level passes only if it halted within the SLO AND there was work to halt: a scope with no
 * jobs proves nothing, so an idle run is INCOMPLETE (put the scope under load and re-run).
 */
export function wasUnderLoad(outcome: LevelOutcome): boolean {
  if (outcome.kind === 'drain') {
    const first = outcome.result.samples[0]?.active ?? {};
    return Object.values(first).some((n) => n > 0);
  }
  if (outcome.kind === 'halt') {
    return outcome.activityBefore > 0 || (outcome.result.samples[0]?.inFlight ?? 0) > 0;
  }
  return false;
}

export function levelVerdict(outcome: LevelOutcome): Verdict {
  switch (outcome.kind) {
    case 'drain':
      if (!outcome.result.drained || !outcome.result.withinSlo) return 'FAIL';
      return wasUnderLoad(outcome) ? 'PASS' : 'INCOMPLETE';
    case 'halt':
      if (!outcome.result.withinSlo) return 'FAIL';
      return wasUnderLoad(outcome) ? 'PASS' : 'INCOMPLETE';
    case 'unmeasured':
      return 'INCOMPLETE';
    case 'error':
      return 'FAIL';
  }
}

export function levelSection(outcome: LevelOutcome): GateSection {
  const { plan } = outcome;
  const title = `Kill switch — ${plan.level}${plan.target ? ` (${plan.target})` : ''}`;
  const verdict = levelVerdict(outcome);
  const idle =
    verdict === 'INCOMPLETE' && (outcome.kind === 'drain' || outcome.kind === 'halt')
      ? [
          'INCOMPLETE — no in-scope work was running when the switch was engaged, so the timing',
          'proves nothing. Put the scope under load (k6 + real generations / scheduled posts) and re-run.',
        ]
      : [];
  switch (outcome.kind) {
    case 'drain':
      return { title, verdict, lines: [...idle, '```', formatReport(plan, outcome.result), '```'] };
    case 'halt':
      return {
        title,
        verdict,
        lines: [
          ...idle,
          `In-scope starts in the ${LOAD_WINDOW_MS / 60_000} min before engaging: ${outcome.activityBefore}.`,
          '```',
          formatHaltReport(plan, outcome.result),
          '```',
        ],
      };
    case 'unmeasured':
      return { title, verdict, lines: [outcome.note] };
    case 'error':
      return { title, verdict, lines: [`Error: ${outcome.message}`] };
  }
}

/** Time recorded for the results table (seconds, one decimal) or '—'. */
export function levelSeconds(outcome: LevelOutcome): string {
  if (outcome.kind === 'drain' || outcome.kind === 'halt') {
    return (outcome.result.elapsedMs / 1000).toFixed(1);
  }
  return '—';
}

export const UNMEASURED_NOTE = (level: RehearsalLevel) =>
  `Engaged and released through the Admin API, but not timed: the ${level} level is measured ` +
  'from the staging database and STAGING_DATABASE_URL (a read-only role) was not set. Set it and ' +
  're-run, or follow the manual checks in runbooks/kill-switch.md.';

// ---------------------------------------------------------------- rollback (BACKLOG 12.3)

export const ROLLBACK_SLO_MS = 5 * 60_000;

/**
 * STAGING_DEPLOY_CMD is an operator-owned shell template containing `{tag}`, e.g.
 *   IMAGE_TAG={tag} docker compose -f docker-compose.prod.yml up -d --no-deps web worker-…
 *   aws ecs update-service … --task-definition studio-staging:{tag} && aws ecs wait services-stable …
 * The tag is validated against the registry tag grammar before substitution, so no shell
 * metacharacters can come from it.
 */
export function renderDeployCommand(template: string | undefined, tag: string): string {
  const t = template?.trim();
  if (!t) throw new ConfigurationError('STAGING_DEPLOY_CMD is required (a command with {tag})');
  if (!t.includes('{tag}')) throw new ConfigurationError('STAGING_DEPLOY_CMD must contain {tag}');
  if (!IMAGE_TAG.test(tag)) throw new ValidationError(`invalid image tag "${tag}"`);
  return t.split('{tag}').join(tag);
}

export interface ReadyDeps {
  /** HTTP status of GET <staging>/api/health/ready (0 for a network error). */
  probe: () => Promise<number>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface ReadyResult {
  ready: boolean;
  elapsedMs: number;
  samples: Array<{ atMs: number; status: number }>;
}

/**
 * Poll readiness until `stableSamples` consecutive 200s (so a single replica answering during a
 * rolling restart can't end the timer early); the time recorded is the first 200 of that run.
 */
export async function waitForReady(
  deps: ReadyDeps,
  opts: { startedAt: number; intervalMs?: number; timeoutMs?: number; stableSamples?: number },
): Promise<ReadyResult> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? ROLLBACK_SLO_MS * 3;
  const stableSamples = opts.stableSamples ?? 3;
  if (intervalMs <= 0 || timeoutMs <= 0 || stableSamples < 1) {
    throw new ValidationError('Invalid readiness options');
  }
  const samples: ReadyResult['samples'] = [];
  let streak = 0;
  let firstOkAt: number | undefined;
  for (;;) {
    const status = await deps.probe();
    const atMs = deps.now() - opts.startedAt;
    samples.push({ atMs, status });
    if (status === 200) {
      streak += 1;
      firstOkAt ??= atMs;
    } else {
      streak = 0;
      firstOkAt = undefined;
    }
    if (streak >= stableSamples && firstOkAt !== undefined) {
      return { ready: true, elapsedMs: firstOkAt, samples };
    }
    if (atMs >= timeoutMs) return { ready: false, elapsedMs: atMs, samples };
    await deps.sleep(intervalMs);
  }
}

export interface RollbackPhase {
  tag: string;
  deployExitCode: number;
  deployMs: number;
  ready: ReadyResult;
}

export function rollbackSections(input: {
  fromTag: string;
  toTag: string;
  forward: RollbackPhase;
  rollback?: RollbackPhase;
}): { verdict: Verdict; sections: GateSection[]; rollbackSeconds: string } {
  const phaseLines = (p: RollbackPhase) => [
    `- deploy command exit code: ${p.deployExitCode} after ${(p.deployMs / 1000).toFixed(1)}s`,
    `- readiness: ${p.ready.ready ? `green at ${(p.ready.elapsedMs / 1000).toFixed(1)}s` : `NOT green after ${(p.ready.elapsedMs / 1000).toFixed(1)}s`}`,
    `- samples: ${p.ready.samples.map((s) => `${(s.atMs / 1000).toFixed(0)}s=${s.status}`).join(' ')}`,
  ];
  const forwardOk = input.forward.deployExitCode === 0 && input.forward.ready.ready;
  const sections: GateSection[] = [
    {
      title: `Deploy N+1 (${input.toTag})`,
      verdict: forwardOk ? 'PASS' : 'FAIL',
      lines: phaseLines(input.forward),
    },
  ];
  if (!input.rollback) {
    sections.push({
      title: `Roll back to N (${input.fromTag})`,
      verdict: 'INCOMPLETE',
      lines: ['Not attempted: deploying N+1 did not reach readiness. Fix staging, then re-run.'],
    });
    return { verdict: 'FAIL', sections, rollbackSeconds: '—' };
  }
  const r = input.rollback;
  const withinSlo = r.deployExitCode === 0 && r.ready.ready && r.ready.elapsedMs <= ROLLBACK_SLO_MS;
  const secs = (r.ready.elapsedMs / 1000).toFixed(1);
  sections.push({
    title: `Roll back to N (${input.fromTag}) — timed against the 5 min SLO`,
    verdict: withinSlo ? 'PASS' : 'FAIL',
    lines: [
      withinSlo
        ? `PASS — readiness green ${secs}s after the rollback started (SLO 300s).`
        : `FAIL — ${r.ready.ready ? `readiness green after ${secs}s, over the 300s SLO` : 'readiness never went green'}${r.deployExitCode === 0 ? '' : `; deploy exited ${r.deployExitCode}`}.`,
      ...phaseLines(r),
      '',
      'Then, by hand (runbooks/rollback.md): confirm N runs correctly on the N+1 schema (golden-path',
      'smoke), redeploy N+1 and confirm it runs. Readiness is read through the load balancer, so',
      'also confirm every replica reports the N tag in your orchestrator.',
    ],
  });
  return { verdict: forwardOk && withinSlo ? 'PASS' : 'FAIL', sections, rollbackSeconds: secs };
}
