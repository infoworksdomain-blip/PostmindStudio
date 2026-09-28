import { ConfigurationError, ValidationError } from '../../../errors';
import type { GateSection, Verdict } from './report';

// Phase 14.7 — point-in-time restore verification (pure; unit tested). Flow
// (runbooks/backup-recovery.md "Restore drill"):
//   1. BEFORE the drill: `staging-gate.ts --snapshot` records every studio table's row count and
//      the latest write time from the source database.
//   2. DevOps performs the PITR restore into a new instance.
//   3. `staging-gate.ts --restore-check` against the restored DATABASE_URL: `prisma migrate
//      status`, row counts vs the snapshot, pgvector present and working, a read-only smoke, and
//      the RTO/RPO inputs.

export const STUDIO_SCHEMA = 'studio';
/** Plain SQL identifiers only: table names are interpolated into count queries. */
export const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function assertIdentifier(name: string): string {
  if (!SQL_IDENTIFIER.test(name)) throw new ValidationError(`Unexpected table name "${name}"`);
  return name;
}

export interface RowSnapshot {
  version: 1;
  capturedAt: string;
  /** Redacted database URL (host / database only). */
  database: string;
  schema: string;
  tables: Record<string, number>;
  /** Latest createdAt/updatedAt across the schema at capture time (ISO), or null. */
  latestWriteAt: string | null;
}

export function parseSnapshot(raw: unknown): RowSnapshot {
  const s = raw as Partial<RowSnapshot> | null;
  if (
    !s ||
    s.version !== 1 ||
    typeof s.capturedAt !== 'string' ||
    typeof s.tables !== 'object' ||
    s.tables === null
  ) {
    throw new ConfigurationError(
      'Not a staging-gate snapshot file (run staging-gate.ts --snapshot)',
    );
  }
  for (const [table, n] of Object.entries(s.tables)) {
    assertIdentifier(table);
    if (!Number.isInteger(n) || n < 0) throw new ConfigurationError(`Bad row count for ${table}`);
  }
  return {
    version: 1,
    capturedAt: s.capturedAt,
    database: String(s.database ?? ''),
    schema: String(s.schema ?? STUDIO_SCHEMA),
    tables: s.tables,
    latestWriteAt: typeof s.latestWriteAt === 'string' ? s.latestWriteAt : null,
  };
}

export type RowStatus =
  'ok' | 'more_rows' | 'fewer_rows' | 'emptied' | 'missing_table' | 'new_table';

export interface RowComparison {
  table: string;
  snapshot: number | null;
  restored: number | null;
  status: RowStatus;
}

/**
 * The restore target is at or after the snapshot, so tables normally have the same or more rows.
 * Fewer rows is a warning (some tables delete: idempotency, outbox, purges); a table that was
 * emptied or is missing fails the check.
 */
export function compareRowCounts(
  snapshot: Record<string, number>,
  restored: Record<string, number>,
): RowComparison[] {
  const tables = [...new Set([...Object.keys(snapshot), ...Object.keys(restored)])].sort();
  return tables.map((table) => {
    const before = snapshot[table];
    const after = restored[table];
    if (before === undefined)
      return { table, snapshot: null, restored: after ?? 0, status: 'new_table' };
    if (after === undefined)
      return { table, snapshot: before, restored: null, status: 'missing_table' };
    const status: RowStatus =
      after === before
        ? 'ok'
        : after > before
          ? 'more_rows'
          : after === 0
            ? 'emptied'
            : 'fewer_rows';
    return { table, snapshot: before, restored: after, status };
  });
}

export function rowCountVerdict(rows: readonly RowComparison[]): Verdict {
  return rows.some((r) => r.status === 'missing_table' || r.status === 'emptied') ? 'FAIL' : 'PASS';
}

export interface MigrateStatus {
  upToDate: boolean;
  summary: string;
}

/**
 * `prisma migrate status` exits 0 and prints "Database schema is up to date!" when every
 * migration is applied; it exits non-zero and lists pending / failed migrations otherwise
 * (https://www.prisma.io/docs/orm/reference/prisma-cli-reference#migrate-status).
 */
export function parseMigrateStatus(output: string, exitCode: number): MigrateStatus {
  const upToDate = exitCode === 0 && /schema is up to date/i.test(output);
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // Never echo the datasource line (it can carry the host / user); drop npm's own chatter.
    .filter((l) => !/^Datasource|postgres(ql)?:\/\//i.test(l))
    .filter((l) => !/^(npm (warn|notice)|warn The configuration|For more information)/i.test(l));
  return { upToDate, summary: lines.slice(-12).join('\n') };
}

export interface RtoRpoInput {
  /** When the data loss / incident happened (drill: the chosen restore point). */
  incidentAt?: string;
  /** When DevOps started the restore. */
  restoreStartedAt?: string;
  /** The PITR target time requested. */
  restoreTarget?: string;
  /** Latest write found in the restored database. */
  restoredLatestWriteAt: string | null;
  /** When this check finished (restore verified). */
  verifiedAt: string;
}

export interface RtoRpo {
  rpoSeconds: number | null;
  rtoSeconds: number | null;
  notes: string[];
}

const ms = (iso: string | undefined | null) => (iso ? Date.parse(iso) : Number.NaN);

/** RPO = incident (or target) − latest restored write; RTO = verified − restore started. */
export function computeRtoRpo(input: RtoRpoInput): RtoRpo {
  const notes: string[] = [];
  const reference = input.incidentAt ?? input.restoreTarget;
  const rpo = ms(reference) - ms(input.restoredLatestWriteAt);
  const rto = ms(input.verifiedAt) - ms(input.restoreStartedAt);
  if (!reference) notes.push('RPO needs --incident-at or --restore-target.');
  if (!input.restoredLatestWriteAt)
    notes.push('No createdAt/updatedAt found in the restored data.');
  if (!input.restoreStartedAt) notes.push('RTO needs --restore-started-at (when DevOps began).');
  return {
    rpoSeconds: Number.isFinite(rpo) ? Math.max(0, Math.round(rpo / 1000)) : null,
    rtoSeconds: Number.isFinite(rto) ? Math.max(0, Math.round(rto / 1000)) : null,
    notes,
  };
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Runs named checks in order; one failing never stops the rest. */
export async function runChecks(
  checks: ReadonlyArray<{ name: string; run: () => Promise<string> }>,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      results.push({ name: check.name, ok: true, detail: await check.run() });
    } catch (err) {
      results.push({
        name: check.name,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export function restoreSections(input: {
  migrate: MigrateStatus;
  rows: RowComparison[];
  snapshot: RowSnapshot;
  vector: CheckResult;
  smoke: CheckResult[];
  rtoRpo: RtoRpo;
}): { verdict: Verdict; sections: GateSection[] } {
  const rowsVerdict = rowCountVerdict(input.rows);
  const smokeVerdict: Verdict = input.smoke.every((c) => c.ok) ? 'PASS' : 'FAIL';
  const changed = input.rows.filter((r) => r.status !== 'ok');
  const sections: GateSection[] = [
    {
      title: 'Migrations (prisma migrate status)',
      verdict: input.migrate.upToDate ? 'PASS' : 'FAIL',
      lines: ['```', input.migrate.summary || '(no output)', '```'],
    },
    {
      title: `Row counts vs snapshot of ${input.snapshot.capturedAt}`,
      verdict: rowsVerdict,
      lines: [
        `${input.rows.length} tables compared; ${input.rows.length - changed.length} identical.`,
        ...(changed.length
          ? [
              '| Table | Snapshot | Restored | Status |',
              '| --- | --- | --- | --- |',
              ...changed.map(
                (r) => `| ${r.table} | ${r.snapshot ?? '—'} | ${r.restored ?? '—'} | ${r.status} |`,
              ),
            ]
          : []),
        'more_rows is expected when the restore point is after the snapshot; fewer_rows is a',
        'warning (tables that delete rows); emptied or missing_table fails the check.',
      ],
    },
    {
      title: 'pgvector',
      verdict: input.vector.ok ? 'PASS' : 'FAIL',
      lines: [input.vector.detail],
    },
    {
      title: 'Read-only smoke',
      verdict: smokeVerdict,
      lines: input.smoke.map((c) => `- ${c.ok ? 'ok' : 'FAILED'} ${c.name}: ${c.detail}`),
    },
    {
      title: 'RTO / RPO inputs',
      lines: [
        `RPO: ${input.rtoRpo.rpoSeconds === null ? 'not computed' : `${input.rtoRpo.rpoSeconds}s`} (incident or target time − latest write in the restored data).`,
        `RTO: ${input.rtoRpo.rtoSeconds === null ? 'not computed' : `${input.rtoRpo.rtoSeconds}s`} (restore started → this check passed).`,
        ...input.rtoRpo.notes.map((n) => `- ${n}`),
        'Next (runbooks/backup-recovery.md): boot the image against the restored database and run',
        'the golden-path smoke before any cut-over.',
      ],
    },
  ];
  const verdicts: Verdict[] = [
    input.migrate.upToDate ? 'PASS' : 'FAIL',
    rowsVerdict,
    input.vector.ok ? 'PASS' : 'FAIL',
    smokeVerdict,
  ];
  return { verdict: verdicts.includes('FAIL') ? 'FAIL' : 'PASS', sections };
}
