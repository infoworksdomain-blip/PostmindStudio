import type { PrismaClient, SystemFlag } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import { flagKeys } from '../system-flags';
import {
  cancelGlobalKillRequest,
  changeKillSwitch,
  confirmGlobalKill,
  GLOBAL_KILL_CONFIRM_WINDOW_MS,
  isExpired,
  killSwitchState,
  parsePending,
  PENDING_GLOBAL_KILL_KEY,
  requestGlobalKill,
  singleApproverEnabled,
} from './kill-switch-admin';

// BACKLOG 15.D6 — two-person global kill, against an in-memory system_flags double.

type Where = { key?: string | { startsWith: string }; value?: string };

function memoryDb() {
  const rows = new Map<string, SystemFlag>();
  const matches = (row: SystemFlag, where: Where) =>
    (typeof where.key === 'string'
      ? row.key === where.key
      : !where.key || row.key.startsWith(where.key.startsWith)) &&
    (where.value === undefined || row.value === where.value);
  const put = (key: string, value: string) => {
    const row = { key, value, updatedAt: new Date() } as SystemFlag;
    rows.set(key, row);
    return row;
  };
  const systemFlag = {
    findUnique: async ({ where }: { where: { key: string } }) => rows.get(where.key) ?? null,
    findMany: async ({ where }: { where: Where }) =>
      [...rows.values()].filter((r) => matches(r, where)),
    create: async ({ data }: { data: { key: string; value: string } }) => {
      if (rows.has(data.key)) throw new Error('unique');
      return put(data.key, data.value);
    },
    updateMany: async ({ where, data }: { where: Where; data: { value: string } }) => {
      const hit = [...rows.values()].filter((r) => matches(r, where));
      for (const r of hit) put(r.key, data.value);
      return { count: hit.length };
    },
    deleteMany: async ({ where }: { where: Where }) => {
      const hit = [...rows.values()].filter((r) => matches(r, where));
      for (const r of hit) rows.delete(r.key);
      return { count: hit.length };
    },
    upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) =>
      put(where.key, create.value),
  };
  const db = { systemFlag, $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db) };
  return { db: db as unknown as PrismaClient, rows };
}

const NOW = Date.parse('2026-09-28T10:00:00Z');
const alice = { userId: 'alice' };
const bob = { userId: 'bob' };
const engage = { level: 'global' as const, enabled: true, reason: 'cost runaway' };

describe('helpers', () => {
  it('reads the break-glass env strictly', () => {
    expect(singleApproverEnabled({ STUDIO_KILL_SWITCH_SINGLE_APPROVER: 'TRUE ' })).toBe(true);
    expect(singleApproverEnabled({ STUDIO_KILL_SWITCH_SINGLE_APPROVER: '1' })).toBe(false);
    expect(singleApproverEnabled({})).toBe(false);
  });

  it('parses stored requests and treats garbage as none', () => {
    expect(parsePending('not json')).toBeNull();
    expect(parsePending(JSON.stringify({ requestId: 'r' }))).toBeNull();
    expect(isExpired({ expiresAt: 'nope' }, NOW)).toBe(true);
    expect(isExpired({ expiresAt: new Date(NOW + 1).toISOString() }, NOW)).toBe(false);
  });
});

describe('changeKillSwitch', () => {
  it('turns a global engage into a pending request without touching studio.killSwitch', async () => {
    const { db, rows } = memoryDb();
    const change = await changeKillSwitch(db, alice, engage, NOW, {});
    expect(change.kind).toBe('pending');
    expect(rows.has(flagKeys.global())).toBe(false);
    const stored = parsePending(rows.get(PENDING_GLOBAL_KILL_KEY)?.value);
    expect(stored).toMatchObject({ requestedBy: 'alice', reason: 'cost runaway' });
    expect(Date.parse(stored?.expiresAt ?? '') - NOW).toBe(GLOBAL_KILL_CONFIRM_WINDOW_MS);
  });

  it('engages at once under break-glass, and releases / other levels immediately', async () => {
    const { db, rows } = memoryDb();
    const glass = await changeKillSwitch(db, alice, engage, NOW, {
      STUDIO_KILL_SWITCH_SINGLE_APPROVER: 'true',
    });
    expect(glass).toMatchObject({ kind: 'set', breakGlass: true, flag: { value: 'true' } });
    // Already engaged: nothing pending, no break-glass marker.
    expect(await changeKillSwitch(db, bob, engage, NOW, {})).toMatchObject({
      kind: 'set',
      breakGlass: false,
    });
    const release = await changeKillSwitch(db, bob, { ...engage, enabled: false }, NOW, {});
    expect(release).toMatchObject({ kind: 'set', flag: { value: 'false' } });
    const provider = await changeKillSwitch(
      db,
      bob,
      { level: 'provider', target: 'runway', enabled: true, reason: 'outage' },
      NOW,
      {},
    );
    expect(provider).toMatchObject({ kind: 'set', breakGlass: false });
    expect(rows.has(PENDING_GLOBAL_KILL_KEY)).toBe(false);
  });
});

describe('requestGlobalKill', () => {
  it('refuses a second request while one is live, and replaces an expired one', async () => {
    const { db } = memoryDb();
    const first = await requestGlobalKill(db, alice, 'first', NOW);
    await expect(requestGlobalKill(db, bob, 'second', NOW + 1_000)).rejects.toThrow(ConflictError);
    const later = NOW + GLOBAL_KILL_CONFIRM_WINDOW_MS + 1;
    const replaced = await requestGlobalKill(db, bob, 'third', later);
    expect(replaced.requestId).not.toBe(first.requestId);
    expect(replaced.requestedBy).toBe('bob');
  });
});

describe('confirmGlobalKill', () => {
  it('lets a different staff member engage it and consumes the request', async () => {
    const { db, rows } = memoryDb();
    const pending = await requestGlobalKill(db, alice, 'runaway', NOW);
    const { flag, request } = await confirmGlobalKill(
      db,
      bob,
      { requestId: pending.requestId, reason: 'agreed' },
      NOW + 60_000,
    );
    expect(flag.value).toBe('true');
    expect(request.requestedBy).toBe('alice');
    expect(rows.has(PENDING_GLOBAL_KILL_KEY)).toBe(false);
    await expect(
      confirmGlobalKill(db, bob, { requestId: pending.requestId, reason: 'again' }, NOW),
    ).rejects.toThrow(NotFoundError);
  });

  it('refuses the requester (403), a stale request id (409) and an expired request (409)', async () => {
    const { db, rows } = memoryDb();
    const pending = await requestGlobalKill(db, alice, 'runaway', NOW);
    const input = { requestId: pending.requestId, reason: 'self approve' };
    await expect(confirmGlobalKill(db, alice, input, NOW)).rejects.toThrow(ForbiddenError);
    await expect(confirmGlobalKill(db, bob, { ...input, requestId: 'other' }, NOW)).rejects.toThrow(
      ConflictError,
    );
    await expect(
      confirmGlobalKill(db, bob, input, NOW + GLOBAL_KILL_CONFIRM_WINDOW_MS),
    ).rejects.toThrow(/expired/);
    expect(rows.has(flagKeys.global())).toBe(false);
    expect(rows.has(PENDING_GLOBAL_KILL_KEY)).toBe(false);
  });
});

describe('cancelGlobalKillRequest and state', () => {
  it('lists the live request, hides an expired one, and withdraws it', async () => {
    const { db } = memoryDb();
    await expect(cancelGlobalKillRequest(db)).rejects.toThrow(NotFoundError);
    const pending = await requestGlobalKill(db, alice, 'runaway', NOW);
    expect((await killSwitchState(db, NOW)).pendingGlobal).toEqual(pending);
    expect(
      (await killSwitchState(db, NOW + GLOBAL_KILL_CONFIRM_WINDOW_MS)).pendingGlobal,
    ).toBeNull();
    expect((await cancelGlobalKillRequest(db)).requestId).toBe(pending.requestId);
    expect((await killSwitchState(db, NOW)).pendingGlobal).toBeNull();
  });
});
