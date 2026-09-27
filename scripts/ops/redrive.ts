import { ConfigurationError, UpstreamServiceError } from '../../src/lib/errors';
import { logger } from '../../src/lib/logger';
import { formatRedriveReport, parseRedriveArgs } from '../../src/lib/studio/ops/redrive-cli';

// Phase 12 — bulk re-drive through the Admin API (runbooks/kill-switch.md, backup-recovery.md).
// Dry run by default; --apply executes.
//
//   STUDIO_URL=https://studio.postmind.ai STUDIO_STAFF_TOKEN=<staff JWT> \
//   npx tsx scripts/ops/redrive.ts kill_switch --since 2026-09-27T09:00:00Z [--level workspace]
//     [--org <organisationId>] [--limit 100] [--apply]
//
//   npx tsx scripts/ops/redrive.ts stuck [--stuck-minutes 30] [--org <id>] [--limit 100] [--apply]
//
// Exit code 0 when the call succeeded (skipped items are reported, not failures).

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigurationError(`Missing required environment variable ${name}`);
  return value;
}

async function main(): Promise<void> {
  const body = parseRedriveArgs(process.argv.slice(2));
  const res = await fetch(`${env('STUDIO_URL')}/api/studio/admin/redrive`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env('STUDIO_STAFF_TOKEN')}`,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new UpstreamServiceError(`redrive POST failed: ${res.status} ${await res.text()}`);
  }
  process.stdout.write(`${formatRedriveReport(await res.json())}\n`);
}

main().catch((err: unknown) => {
  logger.error({ err }, 'redrive failed');
  process.exit(1);
});
