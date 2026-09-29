import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError, ProviderError } from '../errors';
import {
  createResendTransport,
  isRetryableStatus,
  RESEND_API_URL,
  sanitiseTag,
  type OutgoingEmail,
} from './resend-client';

const EMAIL: OutgoingEmail = {
  from: 'PostMind Studio <no-reply@mail.example.com>',
  to: 'amara@example.com',
  subject: 'Reset your password',
  html: '<p>hi</p>',
  text: 'hi',
  replyTo: 'support@example.com',
  headers: { 'List-Unsubscribe': '<https://x/u>' },
  tags: [{ name: 'template', value: 'reset.Password!' }],
  idempotencyKey: 'auth:v1',
};

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('Resend transport', () => {
  it('POSTs the documented body with the key and the idempotency header', async () => {
    const fetchImpl = respond(200, { id: 'em_1' });
    const transport = createResendTransport({ apiKey: 're_test', fetch: fetchImpl as never });
    await expect(transport.send(EMAIL)).resolves.toEqual({ id: 'em_1', alreadySent: false });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_API_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer re_test',
      'idempotency-key': 'auth:v1',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      from: EMAIL.from,
      to: ['amara@example.com'],
      subject: EMAIL.subject,
      html: EMAIL.html,
      text: EMAIL.text,
      reply_to: 'support@example.com',
      headers: { 'List-Unsubscribe': '<https://x/u>' },
      tags: [{ name: 'template', value: 'reset_Password_' }],
    });
  });

  it('classifies failures: 429 / 5xx / concurrent retry, validation does not', async () => {
    const cases: Array<[number, string, boolean]> = [
      [429, 'rate_limit_exceeded', true],
      [500, 'application_error', true],
      [503, 'service_unavailable', true],
      [409, 'concurrent_idempotent_requests', true],
      [422, 'missing_required_field', false],
      [403, 'validation_error', false],
      [401, 'missing_api_key', false],
    ];
    for (const [status, name, retryable] of cases) {
      const transport = createResendTransport({
        apiKey: 're_test',
        fetch: respond(status, { name, message: 'nope', statusCode: status }) as never,
      });
      const err = await transport.send(EMAIL).catch((e: unknown) => e);
      expect(err, `${status} ${name}`).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryable, `${status} ${name}`).toBe(retryable);
      expect((err as ProviderError).errorClass).toBe(name);
    }
    expect(isRetryableStatus(409, 'invalid_idempotent_request')).toBe(false);
  });

  it('treats a reused idempotency key with a different body as already sent', async () => {
    const transport = createResendTransport({
      apiKey: 're_test',
      fetch: respond(409, { name: 'invalid_idempotent_request', message: 'm' }) as never,
    });
    await expect(transport.send(EMAIL)).resolves.toEqual({ id: null, alreadySent: true });
  });

  it('retries network errors and needs an API key', async () => {
    const transport = createResendTransport({
      apiKey: 're_test',
      fetch: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as never,
    });
    const err = await transport.send(EMAIL).catch((e: unknown) => e);
    expect((err as ProviderError).retryable).toBe(true);
    expect(() => createResendTransport({ apiKey: ' ' })).toThrow(ConfigurationError);
  });

  it('sanitises tag values to Resend’s allowed characters', () => {
    expect(sanitiseTag('a b/c')).toBe('a_b_c');
    expect(sanitiseTag('')).toBe('_');
  });
});
