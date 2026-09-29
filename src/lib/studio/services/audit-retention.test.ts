import { describe, expect, it, vi } from 'vitest';
import {
  auditRetentionDays,
  DEFAULT_AUDIT_RETENTION_DAYS,
  purgeExpiredAuditEntries,
} from './audit-retention';

describe('audit retention (Phase 18 §2.6)', () => {
  it('reads STUDIO_AUDIT_RETENTION_DAYS, refusing values under 30 days', () => {
    const warn = vi.fn();
    expect(auditRetentionDays({})).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(auditRetentionDays({ STUDIO_AUDIT_RETENTION_DAYS: '365' })).toBe(365);
    expect(auditRetentionDays({ STUDIO_AUDIT_RETENTION_DAYS: '7' }, { warn })).toBe(730);
    expect(auditRetentionDays({ STUDIO_AUDIT_RETENTION_DAYS: 'x' }, { warn })).toBe(730);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('opts in with SET LOCAL inside the transaction, then deletes before the cutoff', async () => {
    const calls: string[] = [];
    const tx = {
      $executeRawUnsafe: vi.fn(async (sql: string) => {
        calls.push(sql);
        return 0;
      }),
      auditLog: {
        deleteMany: vi.fn(async (args: unknown) => {
          calls.push(JSON.stringify(args));
          return { count: 3 };
        }),
      },
    };
    const db = { $transaction: async (fn: (t: typeof tx) => Promise<number>) => fn(tx) };
    const now = Date.parse('2026-09-29T00:00:00Z');
    await expect(purgeExpiredAuditEntries(db as never, { now, days: 730 })).resolves.toBe(3);
    expect(calls[0]).toBe(`SET LOCAL studio.audit_retention = 'on'`);
    expect(calls[1]).toContain('2024-09-29T00:00:00.000Z');
  });
});
