import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { createLocalAuditSink } from '../../src/lib/audit-local';
import { purgeExpiredAuditEntries } from '../../src/lib/studio/services/audit-retention';

// Phase 18 §2.6 against Postgres: the local sink writes rows, the trigger keeps them append-only,
// and only the retention job can delete old ones. (The trigger's message is asserted in
// test/integration/schema.test.ts; over the PGlite socket server a RAISE surfaces as a generic
// connector error, so here only the refusal and the unchanged rows are checked.)

const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = 86_400_000;

describe.skipIf(!hasDb)('local audit log (DB)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `audit-${Date.now()}`;

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('writes through the sink, refuses edits, and the retention job removes only old rows', async () => {
    const sink = createLocalAuditSink(db);
    const now = Date.now();
    await sink.write({
      organisationId: org,
      actorUserId: 'u1',
      action: 'org.created',
      resource: { type: 'organisation', id: org },
      occurredAt: new Date(now - 800 * DAY),
    });
    await sink.write({
      organisationId: org,
      actorUserId: 'u1',
      action: 'org.renamed',
      resource: { type: 'organisation', id: org },
      occurredAt: new Date(now - DAY),
    });
    const deleted = await purgeExpiredAuditEntries(db, { now, days: 730 });
    expect(deleted).toBeGreaterThanOrEqual(1);
    const left = await db.auditLog.findMany({ where: { organisationId: org } });
    expect(left.map((r) => r.action)).toEqual(['org.renamed']);
    // The opt-in was SET LOCAL: outside the job the trigger still refuses edits and deletes.
    // Checked last: the PGlite socket server may drop the connection after a RAISE.
    await expect(
      db.auditLog.updateMany({ where: { organisationId: org }, data: { action: 'tampered' } }),
    ).rejects.toThrow();
    await expect(db.auditLog.deleteMany({ where: { organisationId: org } })).rejects.toThrow();
  });
});
