import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { ValidationError } from '../../../src/lib/errors';
import type { GateCommand } from '../../../src/lib/studio/ops/staging-gate/args';
import { redactUrl, type GateReport } from '../../../src/lib/studio/ops/staging-gate/report';
import {
  assertIdentifier,
  compareRowCounts,
  computeRtoRpo,
  parseMigrateStatus,
  parseSnapshot,
  restoreSections,
  runChecks,
  STUDIO_SCHEMA,
  type CheckResult,
  type RowSnapshot,
} from '../../../src/lib/studio/ops/staging-gate/restore';
import { vectorSql } from '../../../src/lib/studio/vector-sql';
import { baseContext, env, NEEDS_SHELL_FOR_NPM, out, runProcess } from './common';

// 14.7 — `--snapshot` (before the drill, against the SOURCE database) and `--restore-check`
// (after DevOps restored, against the RESTORED database). Both read DATABASE_URL; point it at
// the right instance for each step. Read-only: counts, max timestamps and SELECTs only.

type SnapshotCommand = Extract<GateCommand, { kind: 'snapshot' }>;
type RestoreCommand = Extract<GateCommand, { kind: 'restore-check' }>;

const table = (name: string) => Prisma.raw(`"${STUDIO_SCHEMA}"."${assertIdentifier(name)}"`);

async function listTables(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${STUDIO_SCHEMA} AND table_type = 'BASE TABLE'
    ORDER BY table_name`;
  return rows.map((r) => r.table_name);
}

async function countRows(db: PrismaClient): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const name of await listTables(db)) {
    const [row] = await db.$queryRaw<Array<{ n: bigint }>>(
      Prisma.sql`SELECT count(*)::bigint AS n FROM ${table(name)}`,
    );
    counts[name] = Number(row?.n ?? 0);
  }
  return counts;
}

async function latestWrite(db: PrismaClient): Promise<string | null> {
  const cols = await db.$queryRaw<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = ${STUDIO_SCHEMA}
      AND column_name IN ('createdAt', 'updatedAt')
      AND data_type LIKE 'timestamp%'`;
  let latest: number | null = null;
  for (const c of cols) {
    const col = Prisma.raw(`"${assertIdentifier(c.column_name)}"`);
    const [row] = await db.$queryRaw<Array<{ m: Date | null }>>(
      Prisma.sql`SELECT max(${col}) AS m FROM ${table(c.table_name)}`,
    );
    const t = row?.m?.getTime();
    if (t !== undefined && (latest === null || t > latest)) latest = t;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export async function runSnapshot(cmd: SnapshotCommand): Promise<GateReport> {
  const startedAt = new Date().toISOString();
  const db = new PrismaClient();
  try {
    const snapshot: RowSnapshot = {
      version: 1,
      capturedAt: new Date().toISOString(),
      database: redactUrl(env('DATABASE_URL')),
      schema: STUDIO_SCHEMA,
      tables: await countRows(db),
      latestWriteAt: await latestWrite(db),
    };
    mkdirSync(dirname(cmd.snapshotFile), { recursive: true });
    writeFileSync(cmd.snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
    out(`Snapshot of ${Object.keys(snapshot.tables).length} tables → ${cmd.snapshotFile}`);
    return {
      check: 'restore-snapshot',
      title: 'Restore drill: pre-restore snapshot (14.7)',
      verdict: 'PASS',
      startedAt,
      finishedAt: new Date().toISOString(),
      context: { ...baseContext(cmd.operator), Database: snapshot.database },
      sections: [
        {
          title: 'Snapshot',
          lines: [
            `${Object.keys(snapshot.tables).length} tables, latest write ${snapshot.latestWriteAt ?? '—'}.`,
            `Saved to ${cmd.snapshotFile}. Keep it for --restore-check after the restore.`,
          ],
        },
      ],
      data: { snapshot },
    };
  } finally {
    await db.$disconnect();
  }
}

/** Each smoke query runs in its own READ ONLY transaction, so the check can never write. */
function readOnly<T>(db: PrismaClient, query: Prisma.PrismaPromise<T>): Promise<T> {
  return db
    .$transaction([db.$executeRaw`SET TRANSACTION READ ONLY`, query])
    .then(([, result]) => result);
}

async function vectorCheck(db: PrismaClient): Promise<CheckResult> {
  const [result] = await runChecks([
    {
      name: 'pgvector',
      run: async () => {
        const v = await vectorSql(db);
        const [row] = await readOnly(
          db,
          db.$queryRaw<Array<{ d: number }>>(
            Prisma.sql`SELECT ('[1,0]'${v.cast} ${v.distance} '[0,1]'${v.cast})::float8 AS d`,
          ),
        );
        if (row?.d === undefined || Math.abs(row.d - 1) > 1e-6) {
          throw new ValidationError(`cosine distance returned ${String(row?.d)}, expected 1`);
        }
        return `extension in schema "${v.schema}"; cosine distance query works`;
      },
    },
  ]);
  return result as CheckResult;
}

function smokeChecks(db: PrismaClient) {
  return [
    {
      name: 'latest project',
      run: async () => {
        const p = await readOnly(
          db,
          db.videoProject.findFirst({
            orderBy: { createdAt: 'desc' },
            select: { id: true, state: true, createdAt: true },
          }),
        );
        return p ? `${p.id} ${p.state} (${p.createdAt.toISOString()})` : 'no projects';
      },
    },
    {
      name: 'publications by state',
      run: async () => {
        const rows = await readOnly(
          db,
          db.videoPublication.groupBy({ by: ['state'], _count: { _all: true } }),
        );
        return rows.map((r) => `${r.state}=${r._count._all}`).join(' ') || 'none';
      },
    },
    {
      name: 'kill-switch flags',
      run: async () => `${await readOnly(db, db.systemFlag.count())} flag row(s)`,
    },
    {
      name: 'provider jobs + cost',
      run: async () => {
        const agg = await readOnly(
          db,
          db.providerJob.aggregate({ _count: { _all: true }, _sum: { costPence: true } }),
        );
        return `${agg._count._all} jobs, ${agg._sum.costPence ?? 0}p recorded`;
      },
    },
    {
      name: 'library embeddings (vector read)',
      run: async () => {
        const v = await vectorSql(db);
        const rows = await readOnly(
          db,
          db.$queryRaw<Array<{ d: number }>>(
            Prisma.sql`SELECT (e.embedding ${v.distance} e.embedding)::float8 AS d
                       FROM "studio"."video_library_embeddings" e LIMIT 1`,
          ),
        );
        return rows.length ? `self-distance ${rows[0]?.d}` : 'no embeddings yet';
      },
    },
  ];
}

export async function runRestoreCheck(cmd: RestoreCommand): Promise<GateReport> {
  const startedAt = new Date().toISOString();
  const database = redactUrl(env('DATABASE_URL'));
  const snapshot = parseSnapshot(JSON.parse(readFileSync(cmd.snapshotFile, 'utf8')) as unknown);
  out('→ prisma migrate status');
  const migrate = await runProcess('npx', ['prisma', 'migrate', 'status'], {
    shell: NEEDS_SHELL_FOR_NPM,
  });
  const db = new PrismaClient();
  try {
    out('→ row counts');
    const restored = await countRows(db);
    const restoredLatest = await latestWrite(db);
    out('→ pgvector + read-only smoke');
    const vector = await vectorCheck(db);
    const smoke = await runChecks(smokeChecks(db));
    const verifiedAt = new Date().toISOString();
    const rtoRpo = computeRtoRpo({
      incidentAt: cmd.incidentAt,
      restoreStartedAt: cmd.restoreStartedAt,
      restoreTarget: cmd.restoreTarget,
      restoredLatestWriteAt: restoredLatest,
      verifiedAt,
    });
    const rows = compareRowCounts(snapshot.tables, restored);
    const { verdict, sections } = restoreSections({
      migrate: parseMigrateStatus(migrate.output, migrate.exitCode),
      rows,
      snapshot,
      vector,
      smoke,
      rtoRpo,
    });
    return {
      check: 'restore-check',
      title: 'Point-in-time restore verification (14.7)',
      verdict,
      startedAt,
      finishedAt: verifiedAt,
      context: {
        ...baseContext(cmd.operator),
        'Restored database': database,
        'Snapshot database': snapshot.database,
        'RPO (s)': String(rtoRpo.rpoSeconds ?? '—'),
        'RTO (s)': String(rtoRpo.rtoSeconds ?? '—'),
      },
      sections,
      data: { rows, restoredLatestWriteAt: restoredLatest, rtoRpo, smoke, vector },
    };
  } finally {
    await db.$disconnect();
  }
}
