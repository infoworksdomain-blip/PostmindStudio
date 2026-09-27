import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, deliverAuditEntry, type AuditEntry } from './audit';
import { logger } from './logger';

const entry: AuditEntry = {
  actorUserId: 'user-1',
  organisationId: 'org-1',
  action: 'studio.project.approve',
  resource: { type: 'video_project', id: 'p1' },
};

const noSleep = vi.fn(async () => undefined);

beforeEach(() => {
  vi.stubEnv('POSTMIND_AUDIT_URL', 'http://core.internal/api/internal/audit');
  vi.stubEnv('POSTMIND_SERVICE_TOKEN', 'svc-token');
  noSleep.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('deliverAuditEntry', () => {
  it('POSTs the entry with source, timestamp and service token', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    await expect(deliverAuditEntry(entry, { fetchImpl, sleep: noSleep })).resolves.toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://core.internal/api/internal/audit');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-Service-Token': 'svc-token' });
    expect(JSON.parse(init.body as string)).toMatchObject({ ...entry, source: 'studio' });
  });

  it('retries with backoff and succeeds on a later attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(deliverAuditEntry(entry, { fetchImpl, sleep: noSleep })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(noSleep.mock.calls).toEqual([[500], [1000]]);
  });

  it('gives up after 3 attempts and logs the full entry for replay', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(deliverAuditEntry(entry, { fetchImpl, sleep: noSleep })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ audit: expect.objectContaining(entry) }),
      expect.stringContaining('delivery failed'),
    );
  });

  it('logs instead of throwing when not configured', async () => {
    vi.stubEnv('POSTMIND_AUDIT_URL', '');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const fetchImpl = vi.fn();
    await expect(deliverAuditEntry(entry, { fetchImpl })).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('auditLog', () => {
  it('returns immediately without throwing even when delivery fails', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      throw new TypeError('down');
    });
    expect(auditLog(entry, { fetchImpl, sleep: noSleep })).toBeUndefined();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
  });
});
