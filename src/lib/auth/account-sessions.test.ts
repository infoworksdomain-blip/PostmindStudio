import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../errors';
import { listUserSessions, revokeOtherSessions, revokeUserSession } from './account-sessions';

const row = (id: string) => ({
  id,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-02T00:00:00Z'),
  expiresAt: new Date('2026-10-01T00:00:00Z'),
  ipAddress: '203.0.113.1',
  userAgent: 'UA',
});

describe('account sessions (Phase 18 §5.4)', () => {
  it('lists live sessions without tokens and marks the current one', async () => {
    const findMany = vi.fn(async () => [row('s1'), row('s2')]);
    const list = await listUserSessions({ session: { findMany } } as never, 'u1', 's2');
    expect(list.map((s) => [s.id, s.current])).toEqual([
      ['s1', false],
      ['s2', true],
    ]);
    expect(JSON.stringify(list)).not.toContain('token');
    const [args] = findMany.mock.calls[0] as unknown as [{ where: { userId: string } }];
    expect(args.where.userId).toBe('u1');
  });

  it('revokes only the caller’s own session (another user’s id is 404)', async () => {
    const deleteMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const db = { session: { deleteMany } } as never;
    await revokeUserSession(db, 'u1', 's1');
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: 's1', userId: 'u1' } });
    await expect(revokeUserSession(db, 'u1', 'someone-elses')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('revokes every other session but keeps the current one', async () => {
    const deleteMany = vi.fn(async () => ({ count: 3 }));
    await expect(
      revokeOtherSessions({ session: { deleteMany } } as never, 'u1', 's9'),
    ).resolves.toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1', id: { not: 's9' } } });
  });
});
