import { ConfigurationError, UpstreamServiceError } from '../../src/lib/errors';
import { logger } from '../../src/lib/logger';
import {
  formatReport,
  parsePlan,
  waitForDrain,
  type RehearsalPlan,
} from '../../src/lib/studio/ops/rehearsal';

// BACKLOG 12.2 — timed kill-switch rehearsal against STAGING (playbook 11.4, runbooks/kill-switch.md).
//
//   STUDIO_URL=https://studio-staging.postmind.ai STUDIO_STAFF_TOKEN=<staging staff JWT> \
//   METRICS_URL=https://studio-staging.internal/api/metrics METRICS_TOKEN=<token> \
//   npx tsx scripts/ops/rehearse-kill-switch.ts global
//   ... workspace <organisationId> | project <projectId> | provider <providerId>
//
// Global: engages the switch, times until every queue reports zero active jobs (SLO 60 s), then
// releases it. Other levels are not visible in the queue gauge (it isn't per-org), so the script
// engages, confirms the flag through the Admin API, waits the 30 s propagation window and prints
// the manual checks from the runbook before releasing. Release always runs, even on failure.

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigurationError(`Missing required environment variable ${name}`);
  return value;
}

const PROPAGATION_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function setSwitch(plan: RehearsalPlan, enabled: boolean): Promise<void> {
  const res = await fetch(`${env('STUDIO_URL')}/api/studio/admin/kill-switch`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${env('STUDIO_STAFF_TOKEN')}`,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({ ...plan, enabled }),
  });
  if (!res.ok) {
    throw new UpstreamServiceError(`kill-switch PUT failed: ${res.status} ${await res.text()}`);
  }
}

async function scrape(): Promise<string> {
  const res = await fetch(env('METRICS_URL'), {
    headers: { authorization: `Bearer ${env('METRICS_TOKEN')}` },
  });
  if (!res.ok) throw new UpstreamServiceError(`metrics scrape failed: ${res.status}`);
  return res.text();
}

async function main(): Promise<void> {
  const plan = parsePlan(process.argv.slice(2));
  const startedAt = Date.now();
  await setSwitch(plan, true);
  let passed = false;
  try {
    if (plan.level === 'global') {
      const result = await waitForDrain({ scrape, now: Date.now, sleep }, { startedAt });
      process.stdout.write(`${formatReport(plan, result)}\n`);
      passed = result.drained && result.withinSlo;
    } else {
      await sleep(PROPAGATION_MS);
      process.stdout.write(
        [
          `Engaged ${plan.level} ${plan.target}; propagation window (30s) elapsed.`,
          'Verify now (runbooks/kill-switch.md), then press Enter to release:',
          plan.level === 'provider'
            ? '  - new shots route to the fallback provider (provider_jobs.providerId)'
            : `  - new jobs for ${plan.target} fail with kill_switch_${plan.level}; other organisations keep processing`,
          '',
        ].join('\n'),
      );
      await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
      passed = true;
    }
  } finally {
    await setSwitch(plan, false);
    logger.info({ level: plan.level, target: plan.target }, 'kill switch released');
  }
  process.exit(passed ? 0 : 1);
}

main().catch((err: unknown) => {
  logger.error({ err }, 'kill-switch rehearsal failed');
  process.exit(1);
});
