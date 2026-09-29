import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { UnauthorizedError, ValidationError } from '../errors';
import { emailAddressHash, suppressAddress, type SuppressionReason } from './suppression';

// Phase 18 §2.8 — Resend's delivery webhooks (POST /api/email/resend/webhook). Resend signs
// every request with Svix. Docs read 2026-09-29:
//   https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests — verify the RAW body
//     with the svix-id / svix-timestamp / svix-signature headers and the endpoint's signing
//     secret (whsec_…, shown on the webhook's page in Resend)
//   https://docs.svix.com/receiving/verifying-payloads/how-manual — signed content
//     "<svix-id>.<svix-timestamp>.<raw body>", HMAC-SHA256 keyed with the base64 part of the
//     secret after "whsec_", base64 digest; the header is a space-separated list of
//     "v1,<signature>"; compare in constant time and reject old timestamps
//   https://resend.com/docs/dashboard/webhooks/event-types and /docs/webhooks/emails/bounced,
//     /complained — { type, created_at, data: { email_id, to: string[], bounce?: { type:
//     'Permanent' | 'Temporary', subType, message } } }
// Implemented with node:crypto (same algorithm as the `svix` / `standardwebhooks` libraries,
// which Studio does not depend on directly); the tests use Svix's published example vector.
//
// Events: email.delivered / email.delivery_delayed update the outbox row; email.bounced with
// bounce.type Permanent and email.complained add every recipient to email_suppressions (hashed);
// email.suppressed (Resend's own list) and email.failed mark the row. Other events are
// acknowledged and ignored. Every handler is idempotent, so Svix redeliveries are harmless.

export const WEBHOOK_TOLERANCE_S = 5 * 60;
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

function secretKey(secret: string): Buffer {
  const base64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  return Buffer.from(base64, 'base64');
}

export function signSvix(secret: string, id: string, timestamp: string, body: string): string {
  const digest = createHmac('sha256', secretKey(secret))
    .update(`${id}.${timestamp}.${body}`, 'utf8')
    .digest('base64');
  return `v1,${digest}`;
}

/** Throws UnauthorizedError unless the body carries a valid, fresh Svix signature. */
export function verifySvixSignature(
  secret: string,
  headers: SvixHeaders,
  body: string,
  nowMs: number,
): void {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) throw new UnauthorizedError('Missing webhook signature');
  const seconds = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(seconds)) {
    throw new UnauthorizedError('Invalid webhook timestamp');
  }
  if (Math.abs(Math.floor(nowMs / 1000) - seconds) > WEBHOOK_TOLERANCE_S) {
    throw new UnauthorizedError('Webhook timestamp outside the tolerance');
  }
  const expected = Buffer.from(signSvix(secret, id, timestamp, body).slice(3), 'base64');
  const matched = signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matched) throw new UnauthorizedError('Invalid webhook signature');
}

export interface ResendEvent {
  type: string;
  data: {
    email_id?: string;
    to?: string[];
    bounce?: { type?: string; subType?: string };
  };
}

export function parseResendEvent(body: string): ResendEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ValidationError('Webhook body must be JSON');
  }
  const event = parsed as { type?: unknown; data?: unknown };
  if (typeof event?.type !== 'string' || typeof event.data !== 'object' || !event.data) {
    throw new ValidationError('Webhook body is not a Resend event');
  }
  const data = event.data as Record<string, unknown>;
  const to = Array.isArray(data.to)
    ? data.to.filter((v): v is string => typeof v === 'string')
    : [];
  const bounce = typeof data.bounce === 'object' && data.bounce ? data.bounce : undefined;
  return {
    type: event.type,
    data: {
      ...(typeof data.email_id === 'string' && { email_id: data.email_id }),
      to,
      ...(bounce && { bounce: bounce as { type?: string; subType?: string } }),
    },
  };
}

type Db = Pick<PrismaClient, 'emailOutbox' | 'emailSuppression'>;

export interface WebhookOutcome {
  handled: boolean;
  /** Address hashes newly suppressed (for the audit trail; never the address). */
  suppressed: Array<{ addressHash: string; reason: SuppressionReason }>;
  organisationId: string | null;
}

async function setState(db: Db, emailId: string | undefined, state: string, from: string[]) {
  if (!emailId) return null;
  const row = await db.emailOutbox.findUnique({
    where: { providerMessageId: emailId },
    select: { id: true, state: true, organisationId: true },
  });
  if (!row) return null;
  if (from.includes(row.state)) {
    await db.emailOutbox.update({ where: { id: row.id }, data: { state } });
  }
  return row;
}

async function suppressAll(db: Db, to: string[], reason: SuppressionReason) {
  const added: WebhookOutcome['suppressed'] = [];
  for (const address of to) {
    if (await suppressAddress(db, address, reason)) {
      added.push({ addressHash: emailAddressHash(address), reason });
    }
  }
  return added;
}

const DELIVERED_FROM = ['sending', 'sent', 'delayed'];

export async function handleResendEvent(db: Db, event: ResendEvent): Promise<WebhookOutcome> {
  const emailId = event.data.email_id;
  const to = event.data.to ?? [];
  switch (event.type) {
    case 'email.delivered': {
      const row = await setState(db, emailId, 'delivered', DELIVERED_FROM);
      return { handled: true, suppressed: [], organisationId: row?.organisationId ?? null };
    }
    case 'email.delivery_delayed': {
      const row = await setState(db, emailId, 'delayed', ['sending', 'sent']);
      return { handled: true, suppressed: [], organisationId: row?.organisationId ?? null };
    }
    case 'email.bounced': {
      // Resend documents email.bounced as a permanent rejection; bounce.type is checked anyway
      // so a temporary bounce never suppresses an address.
      const permanent = (event.data.bounce?.type ?? 'Permanent') === 'Permanent';
      const row = await setState(db, emailId, permanent ? 'bounced' : 'delayed', [
        ...DELIVERED_FROM,
        'delivered',
      ]);
      const suppressed = permanent ? await suppressAll(db, to, 'bounce') : [];
      return { handled: true, suppressed, organisationId: row?.organisationId ?? null };
    }
    case 'email.complained': {
      const row = await setState(db, emailId, 'complained', [...DELIVERED_FROM, 'delivered']);
      const suppressed = await suppressAll(db, to, 'complaint');
      return { handled: true, suppressed, organisationId: row?.organisationId ?? null };
    }
    case 'email.suppressed': {
      // Resend refused to send: the address is on Resend's own suppression list.
      const row = await setState(db, emailId, 'suppressed', DELIVERED_FROM);
      const suppressed = await suppressAll(db, to, 'provider');
      return { handled: true, suppressed, organisationId: row?.organisationId ?? null };
    }
    case 'email.failed': {
      const row = await setState(db, emailId, 'failed', DELIVERED_FROM);
      return { handled: true, suppressed: [], organisationId: row?.organisationId ?? null };
    }
    default:
      return { handled: false, suppressed: [], organisationId: null };
  }
}
