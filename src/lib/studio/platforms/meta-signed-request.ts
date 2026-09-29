import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedError, ValidationError } from '../../errors';

// Phase 18 §2.10 / §5.8 — Meta's `signed_request` (deauthorise and data-deletion callbacks).
// Format (https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback,
// read 2026-09-29): "<base64url signature>.<base64url JSON payload>", where the signature is the
// raw HMAC-SHA256 of the *encoded* payload keyed with the app secret, and the payload is e.g.
// { "algorithm": "HMAC-SHA256", "expires": 1291840400, "issued_at": 1291836800,
//   "user_id": "218471" }. A Page removing the app is reported with `profile_id` (the Page id).

export interface MetaSignedRequest {
  algorithm: 'HMAC-SHA256';
  issuedAt?: number;
  /** App-scoped id of the Facebook user. */
  userId?: string;
  /** Page id when a Page (not a user) removed the app. */
  profileId?: string;
}

const MAX_LENGTH = 8_192;
// Meta ids are positive; a Page removal carries user_id 0, which means "no user".
const GRAPH_ID = /^[1-9]\d{0,63}$/;

function fromBase64Url(part: string): Buffer {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(part)) throw new ValidationError('Malformed signed_request');
  return Buffer.from(part, 'base64url');
}

const optionalId = (value: unknown): string | undefined => {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && GRAPH_ID.test(text) ? text : undefined;
};

/**
 * Verify and decode. A bad signature is 401 (never trust the payload); malformed input is 400.
 * The comparison is constant-time.
 */
export function parseSignedRequest(signedRequest: string, appSecret: string): MetaSignedRequest {
  if (!signedRequest || signedRequest.length > MAX_LENGTH)
    throw new ValidationError('Missing or oversized signed_request');
  const [encodedSig, payload, extra] = signedRequest.split('.');
  if (!encodedSig || !payload || extra !== undefined)
    throw new ValidationError('Malformed signed_request');
  const signature = fromBase64Url(encodedSig);
  const expected = createHmac('sha256', appSecret).update(payload, 'utf8').digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected))
    throw new UnauthorizedError('signed_request signature does not match');

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(payload).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    data = parsed as Record<string, unknown>;
  } catch {
    throw new ValidationError('Malformed signed_request payload');
  }
  if (String(data.algorithm).toUpperCase() !== 'HMAC-SHA256')
    throw new ValidationError('Unsupported signed_request algorithm');
  const userId = optionalId(data.user_id);
  const profileId = optionalId(data.profile_id);
  if (!userId && !profileId) throw new ValidationError('signed_request names no user or Page');
  return {
    algorithm: 'HMAC-SHA256',
    ...(typeof data.issued_at === 'number' && { issuedAt: data.issued_at }),
    ...(userId && { userId }),
    ...(profileId && { profileId }),
  };
}

/** Test and tooling helper: build a signed_request the way Meta does. */
export function signRequest(payload: Record<string, unknown>, appSecret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', appSecret).update(encoded, 'utf8').digest('base64url');
  return `${sig}.${encoded}`;
}

/** The signed_request from a form-encoded (or JSON) callback body. */
export async function readSignedRequestBody(req: Request): Promise<string> {
  const text = await req.text();
  if (text.length > MAX_LENGTH * 2) throw new ValidationError('Request body too large');
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    try {
      const body = JSON.parse(text) as { signed_request?: unknown };
      return typeof body.signed_request === 'string' ? body.signed_request : '';
    } catch {
      throw new ValidationError('Request body must be valid JSON');
    }
  }
  return new URLSearchParams(text).get('signed_request') ?? '';
}
