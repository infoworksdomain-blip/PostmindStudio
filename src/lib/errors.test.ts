import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  ForbiddenError,
  KillSwitchTriggeredError,
  NotFoundError,
  NotImplementedError,
  ProviderError,
  ProvidersUnavailableError,
  RateLimitError,
  StudioError,
  UnauthorizedError,
  UpstreamServiceError,
  ValidationError,
  toErrorResponse,
} from './errors';

describe('error classes', () => {
  it.each([
    [new UnauthorizedError('x'), 401, 'unauthorized'],
    [new ForbiddenError('x'), 403, 'forbidden'],
    [new NotFoundError('x'), 404, 'not_found'],
    [new ValidationError('x'), 400, 'validation_error'],
    [new RateLimitError('x', 30), 429, 'rate_limited'],
    [new KillSwitchTriggeredError('global', 'x'), 503, 'kill_switch_active'],
    [new ProviderError('runway', 'timeout', 'x', true), 502, 'provider_error'],
    [new UpstreamServiceError('x'), 502, 'upstream_error'],
    [new ConfigurationError('x'), 500, 'configuration_error'],
    [new NotImplementedError('x'), 501, 'not_implemented'],
  ])('%o maps to status %i and code %s', (err, status, code) => {
    expect(err).toBeInstanceOf(StudioError);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(err.name).toBe(err.constructor.name);
  });

  it('carries provider metadata for routing decisions', () => {
    const err = new ProviderError('luma', 'rate_limit', 'slow down', true);
    expect(err).toMatchObject({ providerId: 'luma', errorClass: 'rate_limit', retryable: true });
    expect(err.details).toEqual({ providerId: 'luma', errorClass: 'rate_limit', retryable: true });
  });

  it('records the kill switch level', () => {
    const err = new KillSwitchTriggeredError('project', 'killed', { projectId: 'p1' });
    expect(err.level).toBe('project');
    expect(err.details).toEqual({ projectId: 'p1', level: 'project' });
  });
});

describe('toErrorResponse', () => {
  it('renders the Engagement error envelope with details', async () => {
    const res = toErrorResponse(new ValidationError('bad body', { field: 'name' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'validation_error',
      message: 'bad body',
      details: { field: 'name' },
    });
  });

  it('sets Retry-After on rate limits', () => {
    const res = toErrorResponse(new RateLimitError('slow', 42));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
  });

  it('hides unknown errors behind a generic 500', async () => {
    const res = toErrorResponse(new TypeError('secret internals'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'internal_error' });
  });

  it('does not leak configuration detail', async () => {
    const res = toErrorResponse(new ConfigurationError('Missing JWT_SECRET'));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('JWT_SECRET');
  });

  // 20.11 production bug: the Anthropic usage-limit JSON reached a customer.
  it('never passes a provider message or raw body to the caller', async () => {
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."}}';
    const res = toErrorResponse(new ProviderError('anthropic', 'account_limit', raw, false));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: 'provider_error' });
    expect(JSON.stringify(body)).not.toContain('usage limits');
    expect(JSON.stringify(body)).not.toContain('invalid_request_error');
  });

  it('answers 503 service_unavailable with a friendly sentence when every provider is out', async () => {
    const res = toErrorResponse(
      new ProvidersUnavailableError('text_generation', [
        { providerId: 'anthropic', errorClass: 'account_limit', retryAt: '2026-10-01T00:00:00Z' },
        { providerId: 'openai', errorClass: 'insufficient_credits' },
      ]),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('service_unavailable');
    expect(body.message).toMatch(/Generation is unavailable right now/);
    expect(JSON.stringify(body)).not.toContain('anthropic');
  });
});
