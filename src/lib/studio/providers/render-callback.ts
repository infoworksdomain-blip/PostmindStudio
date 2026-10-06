import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigurationError } from '../../errors';

// BACKLOG 23.1 — Shotstack render callbacks. Shotstack's Edit API takes an optional `callback`
// URL in the render request and POSTs the outcome to it when the render is done or failed
// (https://shotstack.io/docs/api/ Edit `callback`; https://shotstack.io/docs/guide/architecting-an-application/webhooks/,
// both read 2026-10-06): payload { type: "edit", action: "render", id, owner, status: "done" |
// "failed", url, error, completed }; up to 10 retries with exponential back-off when the answer
// is outside 200–399 or takes over 10 s; "We do not currently provide signed payloads … make a
// request to the API using your API key and the render ID". Query strings on the callback URL are
// passed through, so each render carries its own unguessable token:
//   ?n=<nonce, 16 random bytes>&s=<HMAC-SHA256(secret, "shotstack-callback:v1:" + nonce)>
// verified in constant time. The payload is never trusted: the route fetches the render's status
// from Shotstack with our key before it wakes the waiting job (api/shotstack-callback.ts).
//
// Enabled only when APP_URL is https (Shotstack must reach it from the internet) and a secret is
// available: STUDIO_RENDER_CALLBACK_SECRET (≥ 32 characters), else one derived from
// BETTER_AUTH_SECRET with HKDF (its own label, so the two secrets never coincide).
// STUDIO_RENDER_CALLBACKS=off turns callbacks off (polling only, as before 23.1).

export const RENDER_CALLBACK_PATH = '/api/studio/webhooks/shotstack';
const TOKEN_LABEL = 'shotstack-callback:v1:';
const HKDF_INFO = 'studio-render-callback-v1';
const MIN_SECRET_CHARS = 32;
const NONCE_BYTES = 16;
/** base64url of NONCE_BYTES bytes / of a SHA-256 digest. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface RenderCallbackConfig {
  /** https origin (and optional base path) of this app, without a trailing slash. */
  baseUrl: string;
  secret: Buffer;
}

type Env = Readonly<Record<string, string | undefined>>;

function signature(secret: Buffer, nonce: string): Buffer {
  return createHmac('sha256', secret).update(`${TOKEN_LABEL}${nonce}`, 'utf8').digest();
}

function secretFrom(env: Env): Buffer | undefined {
  const own = env.STUDIO_RENDER_CALLBACK_SECRET?.trim();
  if (own) {
    if (own.length < MIN_SECRET_CHARS) {
      throw new ConfigurationError(
        `STUDIO_RENDER_CALLBACK_SECRET must be at least ${MIN_SECRET_CHARS} characters`,
      );
    }
    return Buffer.from(own, 'utf8');
  }
  const auth = env.BETTER_AUTH_SECRET?.trim();
  if (!auth || auth.length < MIN_SECRET_CHARS) return undefined;
  return Buffer.from(hkdfSync('sha256', auth, Buffer.alloc(0), HKDF_INFO, 32));
}

/** The callback settings, or undefined when callbacks are off (polling only). */
export function renderCallbackFromEnv(env: Env = process.env): RenderCallbackConfig | undefined {
  if (env.STUDIO_RENDER_CALLBACKS?.trim().toLowerCase() === 'off') return undefined;
  const raw = env.APP_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  const secret = secretFrom(env);
  if (!secret) return undefined;
  return { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, secret };
}

/** A fresh callback URL for one render request. */
export function renderCallbackUrl(
  config: RenderCallbackConfig,
  random: (bytes: number) => Buffer = randomBytes,
): string {
  const nonce = random(NONCE_BYTES).toString('base64url');
  const sig = signature(config.secret, nonce).toString('base64url');
  return `${config.baseUrl}${RENDER_CALLBACK_PATH}?n=${nonce}&s=${sig}`;
}

/** True when (nonce, signature) came from renderCallbackUrl with this secret. Constant time. */
export function verifyRenderCallbackToken(
  secret: Buffer,
  nonce: string | null,
  sig: string | null,
): boolean {
  if (!nonce || !sig || !NONCE_PATTERN.test(nonce) || !SIGNATURE_PATTERN.test(sig)) return false;
  const expected = signature(secret, nonce);
  const given = Buffer.from(sig, 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
