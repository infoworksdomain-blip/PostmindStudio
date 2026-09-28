import { describe, expect, it } from 'vitest';
import { ConfigurationError, ValidationError } from '../../../errors';
import {
  assertIdentifier,
  compareRowCounts,
  computeRtoRpo,
  parseMigrateStatus,
  parseSnapshot,
  restoreSections,
  rowCountVerdict,
  runChecks,
} from './restore';

const snapshot = {
  version: 1,
  capturedAt: '2026-09-28T09:00:00.000Z',
  database: 'postgresql://***:***@db/postgres',
  schema: 'studio',
  tables: { video_projects: 10, provider_jobs: 50, system_flags: 3 },
  latestWriteAt: '2026-09-28T08:59:00.000Z',
};

describe('parseSnapshot', () => {
  it('accepts a snapshot file', () => {
    expect(parseSnapshot(snapshot).tables.video_projects).toBe(10);
  });

  it('rejects other files, bad counts and unsafe table names', () => {
    expect(() => parseSnapshot({ tables: {} })).toThrow(ConfigurationError);
    expect(() => parseSnapshot({ ...snapshot, tables: { a: -1 } })).toThrow('Bad row count');
    expect(() => parseSnapshot({ ...snapshot, tables: { 'x"; drop': 1 } })).toThrow(
      ValidationError,
    );
  });
});

describe('assertIdentifier', () => {
  it('allows plain identifiers only', () => {
    expect(assertIdentifier('video_projects')).toBe('video_projects');
    expect(() => assertIdentifier('a b')).toThrow(ValidationError);
  });
});

describe('compareRowCounts', () => {
  it('classifies each table', () => {
    const rows = compareRowCounts(
      { a: 5, b: 5, c: 5, d: 5, e: 5 },
      { a: 5, b: 7, c: 3, d: 0, f: 1 },
    );
    expect(Object.fromEntries(rows.map((r) => [r.table, r.status]))).toEqual({
      a: 'ok',
      b: 'more_rows',
      c: 'fewer_rows',
      d: 'emptied',
      e: 'missing_table',
      f: 'new_table',
    });
    expect(rowCountVerdict(rows)).toBe('FAIL');
    expect(rowCountVerdict(compareRowCounts({ a: 5 }, { a: 4 }))).toBe('PASS');
  });
});

describe('parseMigrateStatus', () => {
  it('is up to date only on exit 0 with the up-to-date line, and hides the datasource', () => {
    const ok = parseMigrateStatus(
      'Datasource "db": PostgreSQL database "postgres", schema "studio" at "10.0.0.5:5432"\n62 migrations found in prisma/migrations\n\nDatabase schema is up to date!\n',
      0,
    );
    expect(ok.upToDate).toBe(true);
    expect(ok.summary).not.toContain('10.0.0.5');
    const pending = parseMigrateStatus(
      'Following migration have not yet been applied:\n20260930020000_x\n',
      1,
    );
    expect(pending.upToDate).toBe(false);
    expect(pending.summary).toContain('20260930020000_x');
  });
});

describe('computeRtoRpo', () => {
  it('computes RPO from the incident time and RTO from the restore start', () => {
    expect(
      computeRtoRpo({
        incidentAt: '2026-09-28T10:00:00.000Z',
        restoreStartedAt: '2026-09-28T10:05:00.000Z',
        restoredLatestWriteAt: '2026-09-28T09:59:30.000Z',
        verifiedAt: '2026-09-28T10:45:00.000Z',
      }),
    ).toEqual({ rpoSeconds: 30, rtoSeconds: 2400, notes: [] });
  });

  it('falls back to the restore target and explains what is missing', () => {
    const r = computeRtoRpo({
      restoreTarget: '2026-09-28T10:00:00.000Z',
      restoredLatestWriteAt: null,
      verifiedAt: '2026-09-28T10:45:00.000Z',
    });
    expect(r.rpoSeconds).toBeNull();
    expect(r.rtoSeconds).toBeNull();
    expect(r.notes.join(' ')).toContain('--restore-started-at');
  });
});

describe('runChecks', () => {
  it('keeps going after a failure', async () => {
    const results = await runChecks([
      { name: 'a', run: async () => 'fine' },
      {
        name: 'b',
        run: async () => {
          throw new ValidationError('broken');
        },
      },
      { name: 'c', run: async () => 'also fine' },
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1]?.detail).toBe('broken');
  });
});

describe('restoreSections', () => {
  const base = {
    migrate: { upToDate: true, summary: 'Database schema is up to date!' },
    rows: compareRowCounts(snapshot.tables, { ...snapshot.tables, provider_jobs: 52 }),
    snapshot: parseSnapshot(snapshot),
    vector: { name: 'pgvector', ok: true, detail: 'extension in schema "public"' },
    smoke: [{ name: 'latest project', ok: true, detail: 'p1' }],
    rtoRpo: { rpoSeconds: 30, rtoSeconds: 2400, notes: [] },
  };

  it('passes when every part passes and lists only changed tables', () => {
    const r = restoreSections(base);
    expect(r.verdict).toBe('PASS');
    expect(r.sections[1]?.lines.join('\n')).toContain('| provider_jobs | 50 | 52 | more_rows |');
    expect(r.sections[4]?.lines[0]).toContain('RPO: 30s');
  });

  it('fails on pending migrations, a broken vector or a failed smoke query', () => {
    expect(restoreSections({ ...base, migrate: { upToDate: false, summary: '' } }).verdict).toBe(
      'FAIL',
    );
    expect(restoreSections({ ...base, vector: { ...base.vector, ok: false } }).verdict).toBe(
      'FAIL',
    );
    expect(
      restoreSections({ ...base, smoke: [{ name: 'x', ok: false, detail: 'boom' }] }).verdict,
    ).toBe('FAIL');
  });
});
