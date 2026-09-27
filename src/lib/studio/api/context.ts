import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { auditLog, type AuditEntry } from '../../audit';
import { logger } from '../../logger';
import type { TenantResolver } from '../../tenant';
import type { ProviderRegistry } from '../providers/registry';
import type { JobQueue } from '../queue/enqueue';
import type { AssetStorage } from '../storage';
import type { IdempotencyStore } from './idempotency';

// Dependencies for /api/studio route handlers. Built lazily from env in production; tests
// install their own with setApiDeps().

export interface ApiDeps {
  db: PrismaClient;
  queue: JobQueue;
  storage: AssetStorage;
  registry: ProviderRegistry;
  resolveTenant: TenantResolver;
  audit: (entry: AuditEntry) => void;
  idempotency: IdempotencyStore;
  logger: Logger;
  now: () => number;
}

let deps: ApiDeps | undefined;
let building: Promise<ApiDeps> | undefined;

async function buildFromEnv(): Promise<ApiDeps> {
  const [{ prisma }, tenant, enqueue, redis, storage, registry, idempotency] = await Promise.all([
    import('../../prisma'),
    import('../../tenant'),
    import('../queue/enqueue'),
    import('../queue/redis'),
    import('../storage'),
    import('../providers/default-registry'),
    import('./idempotency'),
  ]);
  const connection = redis.redisConnectionFromEnv();
  return {
    db: prisma,
    queue: enqueue.createBullJobQueue(connection),
    storage: storage.getAssetStorage(),
    registry: registry.getProviderRegistry(),
    resolveTenant: tenant.requireTenantContext,
    audit: auditLog,
    idempotency: idempotency.createRedisIdempotencyStore(connection),
    logger,
    now: Date.now,
  };
}

export async function getApiDeps(): Promise<ApiDeps> {
  if (deps) return deps;
  building ??= buildFromEnv().then((built) => (deps = built));
  return building;
}

/** Test hook: install dependencies (pass undefined to reset). */
export function setApiDeps(next: ApiDeps | undefined): void {
  deps = next;
  building = undefined;
}
