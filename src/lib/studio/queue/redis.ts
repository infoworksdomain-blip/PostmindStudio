import type { ConnectionOptions } from 'bullmq';
import { requireEnv } from '../../env';
import { ConfigurationError } from '../../errors';

// BACKLOG 3.1 — BullMQ connection. Studio shares PostMind's Redis cluster and uses DB 3
// (CLAUDE.md). BullMQ requires maxRetriesPerRequest: null for blocking worker connections.

export const STUDIO_REDIS_DB = 3;

export function redisConnectionFromUrl(url: string): ConnectionOptions {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigurationError('REDIS_URL is not a valid URL');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new ConfigurationError('REDIS_URL must use redis:// or rediss://');
  }
  const dbPath = parsed.pathname.replace(/^\//, '');
  const db = dbPath === '' ? STUDIO_REDIS_DB : Number(dbPath);
  if (db !== STUDIO_REDIS_DB) {
    throw new ConfigurationError(
      `Studio must use Redis DB ${STUDIO_REDIS_DB} (REDIS_URL has DB ${dbPath})`,
    );
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    db,
    ...(parsed.username && { username: decodeURIComponent(parsed.username) }),
    ...(parsed.password && { password: decodeURIComponent(parsed.password) }),
    ...(parsed.protocol === 'rediss:' && { tls: {} }),
    maxRetriesPerRequest: null,
  };
}

export function redisConnectionFromEnv(): ConnectionOptions {
  return redisConnectionFromUrl(requireEnv('REDIS_URL'));
}

export function queuePrefix(): string {
  return process.env.BULLMQ_QUEUE_PREFIX?.trim() || 'studio';
}
