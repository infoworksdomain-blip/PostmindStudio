import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditLog, auditLogDurable, setAuditSink } from './audit';
import { createBothAuditSink, createCoreAuditSink, createLocalAuditSink } from './audit-local';
import type { AuditSink } from './audit-sink';
import { logger } from './logger';

afterEach(() => {
  setAuditSink(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const entry = {
  actorUserId: 'u1',
  organisationId: 'org-1',
  action: 'member.invited',
  resource: { type: 'invitation', id: 'inv-1' },
  metadata: { role: 'creator' },
};

describe('audit sinks (Phase 18 §2.6)', () => {
  it('local: one audit_log row with actor type, codes only, clipped text', async () => {
    const create = vi.fn(async () => ({}));
    await createLocalAuditSink({ auditLog: { create } } as never).write({
      ...entry,
      userAgent: 'x'.repeat(2000),
      correlationId: 'c-1',
    });
    const [{ data }] = create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(data).toMatchObject({
      actorUserId: 'u1',
      actorType: 'user',
      organisationId: 'org-1',
      action: 'member.invited',
      resourceType: 'invitation',
      resourceId: 'inv-1',
      metadata: { role: 'creator' },
      correlationId: 'c-1',
    });
    expect((data.userAgent as string).length).toBe(512);
  });

  it('local: an entry without an actor is a system entry', async () => {
    const create = vi.fn(async () => ({}));
    await createLocalAuditSink({ auditLog: { create } } as never).write({
      action: 'auth.sign_in_failed',
      resource: { type: 'auth_email', id: 'abc' },
    });
    const [{ data }] = create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(data).toMatchObject({ actorType: 'system', actorUserId: null, organisationId: null });
  });

  it('core: delivers through the pre-Phase-18 path and rejects when it gives up', async () => {
    vi.stubEnv('POSTMIND_AUDIT_URL', 'http://core/audit');
    vi.stubEnv('POSTMIND_SERVICE_TOKEN', 'tok');
    const ok = vi.fn(async () => new Response(null, { status: 202 }));
    await createCoreAuditSink({ fetchImpl: ok, sleep: async () => undefined }).write(entry);
    expect(ok).toHaveBeenCalledOnce();
    const down = vi.fn(async () => new Response(null, { status: 500 }));
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await expect(
      createCoreAuditSink({ fetchImpl: down, sleep: async () => undefined }).write(entry),
    ).rejects.toThrow(/not delivered/);
  });

  it('both: local first, then Core', async () => {
    const calls: string[] = [];
    const sink = (kind: 'local' | 'core'): AuditSink => ({
      kind,
      write: async () => {
        calls.push(kind);
      },
    });
    await createBothAuditSink(sink('local'), sink('core')).write(entry);
    expect(calls).toEqual(['local', 'core']);
  });
});

describe('auditLog / auditLogDurable routing', () => {
  it('auditLog writes through the configured sink without blocking', async () => {
    const write = vi.fn(async () => undefined);
    setAuditSink({ kind: 'local', write });
    auditLog(entry);
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(entry));
  });

  it('auditLogDurable awaits the write, and logs the full entry when the sink fails', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    setAuditSink({
      kind: 'local',
      write: async () => {
        throw new Error('db down');
      },
    });
    await expect(auditLogDurable(entry)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ audit: entry }),
      expect.stringContaining('replay'),
    );
  });

  it('core mode (null sink) keeps Core delivery for both', async () => {
    vi.stubEnv('POSTMIND_AUDIT_URL', '');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    setAuditSink(null);
    await auditLogDurable(entry);
    expect(error).toHaveBeenCalled();
  });
});
