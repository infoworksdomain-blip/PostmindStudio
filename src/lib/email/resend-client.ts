import { ConfigurationError, ProviderError } from '../errors';

// Phase 18 §2.8 — the one Resend call Studio makes: POST https://api.resend.com/emails.
// Plain fetch instead of the `resend` SDK (one endpoint; no new dependency). Documented shapes,
// read 2026-09-29:
//   https://resend.com/docs/api-reference/emails/send-email — body { from, to, subject, html,
//     text, reply_to, headers, tags[{name,value}] }; response { id }; header Idempotency-Key
//     (unique per request, ≤ 256 characters, kept 24 hours)
//   https://github.com/resend/resend-openapi (resend.yaml, SendEmailRequest) — snake_case
//     `reply_to` in the REST body (the SDKs use replyTo)
//   https://resend.com/docs/dashboard/emails/idempotency-keys — 409 invalid_idempotent_request
//     (key reused with a different body) and 409 concurrent_idempotent_requests (retry later)
//   https://resend.com/docs/api-reference/errors — 400/422 validation, 401/403 key or domain
//     problems, 429 rate / quota limits, 500 / 503 retry later
// Tag names and values may only contain ASCII letters, digits, `_` and `-` (≤ 256 characters).

export const RESEND_API_URL = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 10_000;

export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
  tags?: Array<{ name: string; value: string }>;
  idempotencyKey: string;
}

export interface EmailTransport {
  /** Resolves with Resend's email id; `alreadySent` when the idempotency key was used before. */
  send(email: OutgoingEmail): Promise<{ id: string | null; alreadySent: boolean }>;
}

interface ResendErrorBody {
  name?: string;
  message?: string;
  statusCode?: number;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function errorName(body: unknown): string {
  const name = (body as ResendErrorBody | undefined)?.name;
  return typeof name === 'string' ? name : 'unknown_error';
}

function errorMessage(body: unknown): string {
  const message = (body as ResendErrorBody | undefined)?.message;
  return typeof message === 'string' ? message.slice(0, 300) : 'no message';
}

/** 429, 5xx and a concurrent idempotent request are worth retrying; the rest are not. */
export function isRetryableStatus(status: number, name: string): boolean {
  if (status === 429 || status >= 500) return true;
  return status === 409 && name === 'concurrent_idempotent_requests';
}

export function sanitiseTag(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) || '_';
}

export function createResendTransport(options: {
  apiKey: string;
  fetch?: typeof fetch;
}): EmailTransport {
  const doFetch = options.fetch ?? fetch;
  if (!options.apiKey.trim()) throw new ConfigurationError('RESEND_API_KEY is not set');
  return {
    async send(email) {
      const body = {
        from: email.from,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(email.replyTo && { reply_to: email.replyTo }),
        ...(email.headers && { headers: email.headers }),
        ...(email.tags && {
          tags: email.tags.map((t) => ({ name: sanitiseTag(t.name), value: sanitiseTag(t.value) })),
        }),
      };
      let res: Response;
      try {
        res = await doFetch(RESEND_API_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': email.idempotencyKey.slice(0, 256),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new ProviderError('resend', 'network', `Resend request failed: ${String(err)}`, true);
      }
      const json = await readJson(res);
      if (res.ok) {
        const id = (json as { id?: unknown } | undefined)?.id;
        return { id: typeof id === 'string' ? id : null, alreadySent: false };
      }
      const name = errorName(json);
      // The key was used for an earlier request whose body differed (e.g. a re-render after a
      // deploy changed the wording): that earlier email was accepted, so this one is done.
      if (res.status === 409 && name === 'invalid_idempotent_request') {
        return { id: null, alreadySent: true };
      }
      throw new ProviderError(
        'resend',
        name,
        `Resend answered ${res.status} ${name}: ${errorMessage(json)}`,
        isRetryableStatus(res.status, name),
        { status: res.status },
      );
    },
  };
}
