import { describe, expect, it, vi } from 'vitest';

const { captureException, getClient } = vi.hoisted(() => ({
  captureException: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('@sentry/core', () => ({ captureException, getClient }));

const { reportError } = await import('./errors');

describe('reportError', () => {
  it('does not report when no Sentry client was initialised', () => {
    getClient.mockReturnValue(undefined);
    const err = new Error('boom');

    reportError(err);

    expect(captureException).not.toHaveBeenCalled();
  });

  it('reports the error with extra context when a client is initialised', () => {
    getClient.mockReturnValue({});
    const err = new Error('boom');

    reportError(err, { organisationId: 'org-1', projectId: 'proj-1' });

    expect(captureException).toHaveBeenCalledWith(err, {
      extra: { organisationId: 'org-1', projectId: 'proj-1' },
    });
  });

  it('reports with empty extra context by default', () => {
    getClient.mockReturnValue({});
    const err = new Error('boom');

    reportError(err);

    expect(captureException).toHaveBeenCalledWith(err, { extra: {} });
  });

  it('passes non-Error thrown values through unchanged', () => {
    getClient.mockReturnValue({});

    reportError('a plain string error');

    expect(captureException).toHaveBeenCalledWith('a plain string error', { extra: {} });
  });
});
