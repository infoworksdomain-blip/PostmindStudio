import { ValidationError } from '../../errors';

// Argument parsing and report formatting for scripts/ops/redrive.ts, kept free of I/O so they are
// unit tested. The request body matches redriveInput (services/redrive.ts); the server validates.

export interface RedriveRequestBody {
  scope: 'kill_switch' | 'stuck';
  dryRun: boolean;
  since?: string;
  level?: string;
  organisationId?: string;
  stuckMinutes?: number;
  limit?: number;
}

const FLAGS: Record<string, keyof RedriveRequestBody> = {
  '--since': 'since',
  '--level': 'level',
  '--org': 'organisationId',
  '--stuck-minutes': 'stuckMinutes',
  '--limit': 'limit',
};
const NUMERIC = new Set<keyof RedriveRequestBody>(['stuckMinutes', 'limit']);

export function parseRedriveArgs(argv: string[]): RedriveRequestBody {
  const [scope, ...rest] = argv;
  if (scope !== 'kill_switch' && scope !== 'stuck') {
    throw new ValidationError('first argument must be kill_switch or stuck');
  }
  const body: RedriveRequestBody = { scope, dryRun: true };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i] ?? '';
    if (flag === '--apply') {
      body.dryRun = false;
      continue;
    }
    const field = FLAGS[flag];
    const value = rest[i + 1];
    if (!field) throw new ValidationError(`unknown option ${flag}`);
    if (value === undefined || value.startsWith('--'))
      throw new ValidationError(`${flag} needs a value`);
    i += 1;
    if (NUMERIC.has(field)) {
      const n = Number(value);
      if (!Number.isInteger(n)) throw new ValidationError(`${flag} must be a whole number`);
      Object.assign(body, { [field]: n });
    } else Object.assign(body, { [field]: value });
  }
  if (body.scope === 'kill_switch' && !body.since) {
    throw new ValidationError('kill_switch needs --since <ISO time> (within the last 30 days)');
  }
  return body;
}

interface ReportItem {
  kind: string;
  id: string;
  organisationId: string;
  action: string;
  jobs?: string[];
  skippedReason?: string;
}

interface Report {
  dryRun: boolean;
  scope: string;
  counts: { considered: number; redriven: number; skipped: number };
  items: ReportItem[];
}

export function formatRedriveReport(report: Report): string {
  const verb = report.dryRun ? 'would re-drive' : 're-drove';
  const lines = [
    `Re-drive (${report.scope})${report.dryRun ? ' — DRY RUN, nothing changed' : ''}`,
    `${report.counts.considered} considered, ${verb} ${report.counts.redriven}, skipped ${report.counts.skipped}`,
    ...report.items.map((item) => {
      const what = item.skippedReason
        ? `skipped: ${item.skippedReason}`
        : `${item.action} → ${(item.jobs ?? []).join(', ')}`;
      return `  ${item.kind.padEnd(11)} ${item.id}  org=${item.organisationId}  ${what}`;
    }),
  ];
  if (report.dryRun && report.counts.redriven > 0) lines.push('Run again with --apply to execute.');
  return lines.join('\n');
}
