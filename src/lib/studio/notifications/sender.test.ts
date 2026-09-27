import { createHmac } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError, UpstreamServiceError } from '../../errors';
import {
  bestEffort,
  createWebhookSender,
  inAppOnlySender,
  notificationSenderFromEnv,
  signWebhook,
  toWebhookPayload,
  type OutboundNotification,
} from './sender';

const SECRET = 'a-very-long-webhook-secret';
const notification: OutboundNotification = {
  id: 'n1',
  audience: 'organisation',
  organisationId: 'org-1',
  userId: 'user-1',
  kind: 'publication_failed',
  title: 'Publishing failed',
  body: 'tiktok/rate_limited',
  link: '/projects/p1',
  createdAt: new Date('2026-09-27T10:00:00Z'),
};

describe('createWebhookSender', () => {
  it('POSTs the documented payload, signed over "<timestamp>.<body>"', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await createWebhookSender({
      url: 'https://hooks.example/studio',
      secret: SECRET,
      appUrl: 'https://studio.postmind.ai/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_790_000_000_000,
    }).send(notification);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hooks.example/studio');
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;
    expect(headers['x-studio-timestamp']).toBe('1790000000');
    const expected = createHmac('sha256', SECRET).update(`1790000000.${body}`).digest('hex');
    expect(headers['x-studio-signature']).toBe(`v1=${expected}`);
    expect(JSON.parse(body)).toEqual({
      type: 'studio.notification',
      id: 'n1',
      audience: 'organisation',
      organisationId: 'org-1',
      userId: 'user-1',
      kind: 'publication_failed',
      title: 'Publishing failed',
      body: 'tiktok/rate_limited',
      link: 'https://studio.postmind.ai/projects/p1',
      createdAt: '2026-09-27T10:00:00.000Z',
    });
  });

  it('throws on a non-2xx answer, which bestEffort logs instead of propagating', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 500 }));
    const sender = createWebhookSender({
      url: 'https://hooks.example/studio',
      secret: SECRET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(sender.send(notification)).rejects.toBeInstanceOf(UpstreamServiceError);
    const logger = pino({ level: 'silent' });
    const warn = vi.spyOn(logger, 'warn');
    await expect(bestEffort(sender, logger).send(notification)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('keeps links relative without APP_URL', () => {
    expect(toWebhookPayload(notification).link).toBe('/projects/p1');
    expect(signWebhook('s', '1', 'b')).toMatch(/^v1=[0-9a-f]{64}$/);
  });
});

describe('notificationSenderFromEnv', () => {
  it('is in-app only when no URL is configured', () => {
    expect(notificationSenderFromEnv({})).toBe(inAppOnlySender);
  });

  it.each([
    [{ STUDIO_NOTIFY_WEBHOOK_URL: 'https://h.example' }, 'SECRET'],
    [
      { STUDIO_NOTIFY_WEBHOOK_URL: 'https://h.example', STUDIO_NOTIFY_WEBHOOK_SECRET: 'short' },
      'SECRET',
    ],
    [{ STUDIO_NOTIFY_WEBHOOK_URL: 'not a url', STUDIO_NOTIFY_WEBHOOK_SECRET: SECRET }, 'valid URL'],
    [
      { STUDIO_NOTIFY_WEBHOOK_URL: 'ftp://h.example', STUDIO_NOTIFY_WEBHOOK_SECRET: SECRET },
      'http',
    ],
  ])('refuses %o', (env, message) => {
    expect(() => notificationSenderFromEnv(env)).toThrow(ConfigurationError);
    expect(() => notificationSenderFromEnv(env)).toThrow(message);
  });

  it('builds a signed sender when both are set', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const sender = notificationSenderFromEnv(
      { STUDIO_NOTIFY_WEBHOOK_URL: 'https://h.example/x', STUDIO_NOTIFY_WEBHOOK_SECRET: SECRET },
      fetchImpl as unknown as typeof fetch,
    );
    await sender.send(notification);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
