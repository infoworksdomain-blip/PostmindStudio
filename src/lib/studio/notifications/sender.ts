import { createHmac } from 'node:crypto';
import type { Logger } from 'pino';
import { ConfigurationError, UpstreamServiceError } from '../../errors';

// Spec 14.4 outbound delivery. No PostMind Core notification or email API is documented, so
// Studio does not invent one: notifications are stored in-app (notifier.ts) and optionally
// POSTed to one operator-configured webhook, which ops can bridge to Core, email or Slack.
//
// Webhook contract (STUDIO_NOTIFY_WEBHOOK_URL, signed with STUDIO_NOTIFY_WEBHOOK_SECRET):
//   POST <url>   content-type: application/json
//   X-Studio-Timestamp: <unix seconds>
//   X-Studio-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
//   body: WebhookPayload (below). Receivers should reject timestamps older than 5 minutes.
// Delivery is best effort (one attempt, 5 s timeout): the in-app row is the record.

export type NotificationAudience = 'organisation' | 'staff';

export interface OutboundNotification {
  id: string;
  audience: NotificationAudience;
  organisationId: string | null;
  userId: string | null;
  kind: string;
  title: string;
  body: string;
  /** App-relative path, e.g. /projects/abc. */
  link: string | null;
  createdAt: Date;
}

export interface WebhookPayload {
  type: 'studio.notification';
  id: string;
  audience: NotificationAudience;
  organisationId: string | null;
  userId: string | null;
  kind: string;
  title: string;
  body: string;
  /** Absolute when APP_URL is set, otherwise the app-relative path. */
  link: string | null;
  createdAt: string;
}

export interface NotificationSender {
  send(notification: OutboundNotification): Promise<void>;
}

const WEBHOOK_TIMEOUT_MS = 5_000;

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function toWebhookPayload(n: OutboundNotification, appUrl?: string): WebhookPayload {
  const base = appUrl?.replace(/\/+$/, '');
  return {
    type: 'studio.notification',
    id: n.id,
    audience: n.audience,
    organisationId: n.organisationId,
    userId: n.userId,
    kind: n.kind,
    title: n.title,
    body: n.body,
    link: n.link && base ? `${base}${n.link}` : n.link,
    createdAt: n.createdAt.toISOString(),
  };
}

export function createWebhookSender(options: {
  url: string;
  secret: string;
  appUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): NotificationSender {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  return {
    async send(notification) {
      const body = JSON.stringify(toWebhookPayload(notification, options.appUrl));
      const timestamp = String(Math.floor(now() / 1000));
      const res = await fetchImpl(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-studio-timestamp': timestamp,
          'x-studio-signature': signWebhook(options.secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new UpstreamServiceError('Notification webhook rejected the delivery', {
          status: res.status,
        });
      }
    },
  };
}

/** Delivers nothing: in-app only. */
export const inAppOnlySender: NotificationSender = { send: async () => undefined };

/**
 * Sender from env. Unset URL = in-app only. A URL without a secret (or a non-http(s) URL) is a
 * configuration error: unsigned deliveries could be forged by anyone who learns the URL.
 */
export function notificationSenderFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): NotificationSender {
  const url = env.STUDIO_NOTIFY_WEBHOOK_URL?.trim();
  if (!url) return inAppOnlySender;
  const secret = env.STUDIO_NOTIFY_WEBHOOK_SECRET?.trim();
  if (!secret || secret.length < 16) {
    throw new ConfigurationError(
      'STUDIO_NOTIFY_WEBHOOK_SECRET (≥16 characters) is required when STUDIO_NOTIFY_WEBHOOK_URL is set',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigurationError('STUDIO_NOTIFY_WEBHOOK_URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigurationError('STUDIO_NOTIFY_WEBHOOK_URL must be http(s)');
  }
  return createWebhookSender({
    url,
    secret,
    appUrl: env.APP_URL?.trim() || undefined,
    fetchImpl,
  });
}

/** Wrap a sender so a failed delivery is logged, never thrown (the in-app row already exists). */
export function bestEffort(sender: NotificationSender, logger: Logger): NotificationSender {
  return {
    async send(notification) {
      try {
        await sender.send(notification);
      } catch (err) {
        logger.warn(
          { err, notificationId: notification.id, kind: notification.kind },
          'notification webhook delivery failed',
        );
      }
    },
  };
}
