import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../errors';
import { bootstrapStaff, parseBootstrapArgs } from './superadmin';

describe('parseBootstrapArgs', () => {
  it('reads --email (lowercased) and --role, superadmin by default', () => {
    expect(parseBootstrapArgs(['--email', 'Ops@Example.com'])).toEqual({
      email: 'ops@example.com',
      role: 'superadmin',
    });
    expect(parseBootstrapArgs(['--email', 'a@b.co', '--role', 'staff']).role).toBe('staff');
  });

  it('refuses a missing email, a bad address or an unknown role', () => {
    for (const argv of [[], ['--email', 'nope'], ['--email', 'a@b.co', '--role', 'admin']]) {
      expect(() => parseBootstrapArgs(argv)).toThrow(ValidationError);
    }
  });
});

describe('bootstrapStaff', () => {
  it('creates a verified staff user without a password and emails a set-password link', async () => {
    const create = vi.fn(async () => ({}));
    const send = vi.fn(async () => undefined);
    const audit = vi.fn(async () => undefined);
    const db = { user: { findUnique: vi.fn(async () => null), create }, session: {} };
    const result = await bootstrapStaff(
      { db: db as never, sendSetPasswordLink: send, audit },
      { email: 'Ops@Example.com', role: 'superadmin' },
    );
    expect(result.created).toBe(true);
    const [{ data }] = create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(data).toMatchObject({
      email: 'ops@example.com',
      role: 'superadmin',
      emailVerified: true,
    });
    expect(data).not.toHaveProperty('password');
    expect(send).toHaveBeenCalledWith('ops@example.com');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'staff.role_changed' }));
  });

  it('promotes an existing user, ends their sessions and sends no email', async () => {
    const update = vi.fn(async () => ({}));
    const deleteMany = vi.fn(async () => ({ count: 2 }));
    const send = vi.fn(async () => undefined);
    const db = {
      user: { findUnique: vi.fn(async () => ({ id: 'u1', role: 'user' })), update },
      session: { deleteMany },
    };
    const result = await bootstrapStaff(
      { db: db as never, sendSetPasswordLink: send, audit: async () => undefined },
      { email: 'a@b.co', role: 'staff' },
    );
    expect(result).toEqual({ userId: 'u1', created: false, previousRole: 'user' });
    expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { role: 'staff' } });
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(send).not.toHaveBeenCalled();
  });
});
