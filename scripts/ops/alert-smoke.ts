import { randomUUID } from 'node:crypto';
import { UpstreamServiceError, ValidationError } from '../../src/lib/errors';
import { logger } from '../../src/lib/logger';
import {
  alertsQuery,
  buildSmokeAlerts,
  checkRouting,
  deliveryDelta,
  formatSmokeReport,
  parseNotificationCounters,
  parseSeverities,
  type GettableAlert,
  type PostableAlert,
  type Severity,
} from '../../src/lib/studio/ops/alert-smoke';

// BACKLOG 14.3 — fire a synthetic alert through the deployed Alertmanager and check it is routed
// (severity=page → studio-page/PagerDuty, severity=ticket → studio-ticket/Slack) and delivered.
//
//   ALERTMANAGER_URL=http://127.0.0.1:9093 npx tsx scripts/ops/alert-smoke.ts
//     [--severity page|ticket|page,ticket] [--no-delivery] [--timeout-sec 120]
//
// WARNING: severity=page really pages the PagerDuty on-call. Tell them first, or run
// `--severity ticket` for the Slack path only. The alerts are resolved at the end.
// Exit 0 = every check passed. Uses Alertmanager API v2 (src/lib/studio/ops/alert-smoke.ts).

interface Args {
  severities: Severity[];
  delivery: boolean;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { severities: parseSeverities(undefined), delivery: true, timeoutMs: 120_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--no-delivery') args.delivery = false;
    else if (flag === '--severity' || flag === '--timeout-sec') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new ValidationError(`${flag} needs a value`);
      i += 1;
      if (flag === '--severity') args.severities = parseSeverities(value);
      else {
        const sec = Number(value);
        if (!Number.isInteger(sec) || sec < 15)
          throw new ValidationError('--timeout-sec must be ≥ 15');
        args.timeoutMs = sec * 1000;
      }
    } else throw new ValidationError(`unknown option ${flag}`);
  }
  return args;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const base = (process.env.ALERTMANAGER_URL?.trim() || 'http://127.0.0.1:9093').replace(
    /\/+$/,
    '',
  );
  const runId = randomUUID().slice(0, 8);

  const metrics = async () => {
    const res = await fetch(`${base}/metrics`);
    if (!res.ok) throw new UpstreamServiceError(`GET /metrics returned ${res.status}`);
    return parseNotificationCounters(await res.text());
  };
  const post = async (alerts: PostableAlert[]) => {
    const res = await fetch(`${base}/api/v2/alerts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(alerts),
    });
    if (!res.ok)
      throw new UpstreamServiceError(
        `POST /api/v2/alerts returned ${res.status}: ${await res.text()}`,
      );
  };

  const before = args.delivery ? await metrics() : null;
  await post(buildSmokeAlerts(runId, args.severities, Date.now()));
  process.stdout.write(`Posted ${args.severities.join(' + ')} smoke alert(s), run ${runId}\n`);

  let routing = checkRouting([], runId, args.severities);
  let delivery = null;
  const deadline = Date.now() + args.timeoutMs;
  try {
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/api/v2/alerts?${alertsQuery(runId)}`);
      if (!res.ok) throw new UpstreamServiceError(`GET /api/v2/alerts returned ${res.status}`);
      routing = checkRouting((await res.json()) as GettableAlert[], runId, args.severities);
      if (before) delivery = deliveryDelta(before, await metrics(), args.severities);
      const routed = routing.every((r) => r.ok);
      const delivered = !before || (delivery ?? []).every((d) => d.ok || d.failed > 0);
      if (routed && delivered) break;
      await sleep(5_000);
    }
  } finally {
    // Resolve the smoke alerts (send_resolved closes the PagerDuty incident / posts RESOLVED).
    await post(buildSmokeAlerts(runId, args.severities, Date.now(), { resolved: true })).catch(
      (err: unknown) => logger.warn({ err }, 'could not resolve the smoke alerts'),
    );
  }
  process.stdout.write(`${formatSmokeReport(runId, routing, before ? delivery : null)}\n`);
  const passed = routing.every((r) => r.ok) && (!before || (delivery ?? []).every((d) => d.ok));
  if (!passed) process.exitCode = 1;
}

main().catch((err: unknown) => {
  logger.error({ err }, 'alert smoke test failed');
  process.exitCode = 1;
});
