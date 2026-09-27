import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { auditLog, type AuditEntry } from '../../audit';
import { logger } from '../../logger';
import type { TenantResolver } from '../../tenant';
import type { LibraryDeps } from '../images/library';
import type { OAuthStateStore } from '../platforms/oauth-state';
import type { PublishingDeps } from '../platforms/publishing';
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
  /** Social publishing: publishers, credentials (takedown uses them synchronously). */
  publishing: PublishingDeps;
  oauthState: OAuthStateStore;
  /** Feature D: image library (ingest, generation, embeddings, search). */
  library: LibraryDeps;
  /** Overlay fonts (<FamilyNoSpaces>.ttf) for previews; STUDIO_FONTS_BASE_URL. */
  fontsBaseUrl?: string;
  /** Public origin of Studio (OAuth return URLs must stay on it). */
  appUrl: string;
  logger: Logger;
  now: () => number;
}

let deps: ApiDeps | undefined;
let building: Promise<ApiDeps> | undefined;

async function buildFromEnv(): Promise<ApiDeps> {
  const [
    { prisma },
    tenant,
    enqueue,
    redis,
    storage,
    registry,
    idempotency,
    env,
    createDeps,
    oauthState,
    library,
  ] = await Promise.all([
    import('../../prisma'),
    import('../../tenant'),
    import('../queue/enqueue'),
    import('../queue/redis'),
    import('../storage'),
    import('../providers/default-registry'),
    import('./idempotency'),
    import('../../env'),
    import('../pipeline/create-deps'),
    import('../platforms/oauth-state'),
    import('../images/library'),
  ]);
  const connection = redis.redisConnectionFromEnv();
  const queue = enqueue.createBullJobQueue(connection);
  // Reuse the worker wiring for publishing so API takedowns and workers share one code path.
  const pipeline = createDeps.createPipelineDeps({ db: prisma, queue });
  return {
    db: prisma,
    queue,
    storage: storage.getAssetStorage(),
    registry: registry.getProviderRegistry(),
    resolveTenant: tenant.requireTenantContext,
    audit: auditLog,
    idempotency: idempotency.createRedisIdempotencyStore(connection),
    publishing: pipeline.publishing,
    oauthState: oauthState.createRedisOAuthStateStore(connection),
    library: library.libraryDepsFrom(pipeline),
    fontsBaseUrl: pipeline.config.fontsBaseUrl,
    appUrl: env.requireEnv('APP_URL'),
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
