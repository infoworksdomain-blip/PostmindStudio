import { ConfigurationError, UpstreamServiceError } from '../../src/lib/errors';
import { logger } from '../../src/lib/logger';
import {
  formatReport,
  parsePlan,
  pendingGlobalRequestId,
  waitForDrain,
  type RehearsalPlan,
} from '../../src/lib/studio/ops/rehearsal';

// BACKLOG 12.2 — timed kill-switch rehearsal against STAGING (playbook 11.4, runbooks/kill-switch.md).
//
//   STUDIO_URL=https://studio-staging.postmind.ai STUDIO_STAFF_TOKEN=<staging staff JWT> \
//   METRICS_URL=https://studio-staging.internal/api/metrics METRICS_TOKEN=<token> \
//   STUDIO_CONFIRMER_TOKEN=<a SECOND staff member's staging JWT> (two-person global kill, 15.D6) \
//   npx tsx scripts/ops/rehearse-kill-switch.ts global
//   ... workspace <organisationId> | project <projectId> | provider <providerId> | platform <p>
//
// Phase 14.6: `staging-gate.ts --rehearse kill-switch` times every level unattended (the scoped
// levels from the staging database) and writes the GATE 12 report; this script stays for a
// quick interactive check.
//
// Global (15.D6 / spec 19.2 two-person approval): the PUT only creates a pending request; the
// script confirms it with STUDIO_CONFIRMER_TOKEN (a different staff user — the API refuses the
// requester), then times until every queue reports zero active jobs (SLO 60 s, measured from the
// confirmation, when the flag is actually set), then releases it. Other levels are not visible in the queue gauge (it isn't per-org), so the script
// engages, confirms the flag through the Admin API, waits the 30 s propagation window and prints
// the manual checks from the runbook before releasing. Release always runs, even on failure.

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigurationError(`Missing required environment variable ${name}`);
  return value;
}

const PROPAGATION_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function adminCall(
  method: 'PUT' | 'POST',
  path: string,
  token: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${env('STUDIO_URL')}/api/studio/admin/kill-switch${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok)
    throw new UpstreamServiceError(`kill-switch ${method}${path} failed: ${res.status} ${text}`);
  return { status: res.status, json: text ? (JSON.parse(text) as unknown) : {} };
}

/** Engage or release; resolves when the flag-setting call started (the drain timer's zero). */
async function setSwitch(plan: RehearsalPlan, enabled: boolean): Promise<number> {
  let setAt = Date.now();
  const res = await adminCall('PUT', '', env('STUDIO_STAFF_TOKEN'), { ...plan, enabled });
  const requestId = enabled ? pendingGlobalRequestId(res.status, res.json) : undefined;
  if (requestId) {
    // Two-person approval: a different staff member confirms within 10 minutes.
    setAt = Date.now();
    await adminCall('POST', '/global/confirm', env('STUDIO_CONFIRMER_TOKEN'), {
      requestId,
      reason: `${plan.reason} (second approver)`,
    });
  }
  return setAt;
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
  if (plan.level === 'global') env('STUDIO_CONFIRMER_TOKEN'); // fail before engaging anything
  const startedAt = await setSwitch(plan, true);
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
            : plan.level === 'platform'
              ? `  - new ${plan.target} publications fail as kill_switch_platform; other platforms keep publishing`
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
