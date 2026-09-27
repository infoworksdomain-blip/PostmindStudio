import { randomBytes } from 'node:crypto';
import type { ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { OAuthPlatform } from './oauth';

// Server-side OAuth state: the `state` parameter is a random handle; who started the flow (and the
// PKCE verifier) never travels through the browser. Single use, 10-minute TTL.

export const OAUTH_STATE_TTL_SEC = 10 * 60;

export interface OAuthPending {
  organisationId: string;
  userId: string;
  businessId: string;
  platform: OAuthPlatform;
  codeVerifier?: string;
  /** Where to send the browser after the callback (validated against APP_URL). */
  returnTo?: string;
}

export interface OAuthStateStore {
  create(pending: OAuthPending): Promise<string>;
  /** Returns and deletes the pending flow; null if unknown, used or expired. */
  consume(state: string): Promise<OAuthPending | null>;
}

const newState = () => randomBytes(24).toString('base64url');
const key = (state: string) => `studio:oauth:${state}`;

export function createMemoryOAuthStateStore(now: () => number = Date.now): OAuthStateStore {
  const entries = new Map<string, { pending: OAuthPending; expiresAt: number }>();
  return {
    async create(pending) {
      const state = newState();
      entries.set(state, { pending, expiresAt: now() + OAUTH_STATE_TTL_SEC * 1000 });
      return state;
    },
    async consume(state) {
      const entry = entries.get(state);
      entries.delete(state);
      return entry && entry.expiresAt > now() ? entry.pending : null;
    },
  };
}

export function createRedisOAuthStateStore(connection: ConnectionOptions): OAuthStateStore {
  const redis = new Redis({
    ...(connection as object),
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
  return {
    async create(pending) {
      const state = newState();
      await redis.set(key(state), JSON.stringify(pending), 'EX', OAUTH_STATE_TTL_SEC);
      return state;
    },
    async consume(state) {
      // GETDEL (Redis ≥ 6.2) makes the state strictly single-use.
      const raw = await redis.getdel(key(state));
      return raw ? (JSON.parse(raw) as OAuthPending) : null;
    },
  };
}
