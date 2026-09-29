import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { NOTIFICATION_KINDS, type NotificationKind } from './notifier';

// Phase 18 §2.8 — the unsubscribe link in notification emails (PECR / GDPR; RFC 8058 one-click).
// The token is an HMAC (STUDIO_UNSUBSCRIBE_SECRET) over the user, the organisation and the
// notification kind, so it can only ever turn email OFF for that one kind of that one user —
// nothing else, which is why it needs no sign-in and does not expire. Auth, billing and account
// mail carry no such link and cannot be unsubscribed from (emails/catalogue.ts).
//
//   token = "v1." + base64url(JSON {u, o, k}) + "." + base64url(HMAC-SHA256(secret, "unsubscribe.v1." + payload))

export interface UnsubscribeClaims {
  userId: string;
  organisationId: string;
  kind: NotificationKind;
}

const VERSION = 'v1';
const MAX_TOKEN_LENGTH = 1_024;
const KINDS: ReadonlySet<string> = new Set(NOTIFICATION_KINDS);

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`unsubscribe.${VERSION}.${payload}`, 'utf8').digest();
}

export function signUnsubscribeToken(claims: UnsubscribeClaims, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ u: claims.userId, o: claims.organisationId, k: claims.kind }),
    'utf8',
  ).toString('base64url');
  return `${VERSION}.${payload}.${mac(secret, payload).toString('base64url')}`;
}

/** The claims of a valid token; null for anything malformed, tampered with or unknown. */
export function verifyUnsubscribeToken(
  token: string | null | undefined,
  secret: string,
): UnsubscribeClaims | null {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const [version, payload, signature, ...rest] = token.split('.');
  if (version !== VERSION || !payload || !signature || rest.length > 0) return null;
  const expected = mac(secret, payload);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const { u, o, k } = claims;
    if (typeof u !== 'string' || typeof o !== 'string' || typeof k !== 'string') return null;
    if (!u || !o || !KINDS.has(k)) return null;
    return { userId: u, organisationId: o, kind: k as NotificationKind };
  } catch {
    return null;
  }
}

export function unsubscribeUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

/** Turn email off for the kind (in-app stays as it was; a new row keeps in-app on). */
export async function applyUnsubscribe(
  db: Pick<PrismaClient, 'notificationPreference'>,
  claims: UnsubscribeClaims,
): Promise<void> {
  const { organisationId, userId, kind } = claims;
  await db.notificationPreference.upsert({
    where: { organisationId_userId_kind: { organisationId, userId, kind } },
    create: { organisationId, userId, kind, email: false },
    update: { email: false },
  });
}
