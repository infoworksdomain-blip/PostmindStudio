import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { auditLog, type AuditEntry } from '../../audit';
import { logger } from '../../logger';
import type { TenantResolver } from '../../tenant';
import type { CoreBusinessDirectory } from '../core/business-directory';
import type { CoreChannelDirectory } from '../core/channel-directory';
import type { CoreContentClient } from '../core/content-client';
import type { LibraryDeps } from '../images/library';
import type { VoiceCloningClient } from '../providers/elevenlabs-voices';
import type { OAuthStateStore } from '../platforms/oauth-state';
import type { PublishingDeps } from '../platforms/publishing';
import type { CircuitBreaker } from '../providers/circuit-breaker';
import type { ProviderRegistry } from '../providers/registry';
import type { InspectableQueue } from '../services/admin-health';
import type { DeadLetterQueue } from '../services/dead-letter';
import type { UploadDeps } from '../uploads/signer';
import type { ThumbnailComposer } from '../services/thumbnail-composer';
import type { BetaPlanLookup } from '../services/beta';
import type { JobQueue } from '../queue/enqueue';
import type { AssetStorage } from '../storage';
import { devTenantFromEnv } from './dev-tenant';
import type { IdempotencyStore } from './idempotency';
import type { RateLimiter } from './rate-limit';
import type { AuditSink } from '../../audit-sink';
import type { AuthMailer } from '../../email/auth-mailer';
import type { IdentityProvider } from '../../identity/provider';
import type { StudioModes } from '../../mode';
import type { BillingService } from '../billing/contracts';
import type { EntitlementsReader } from '../billing/entitlements-reader';

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
  /** Per-user / per-organisation request limits; absent = unlimited (tests). */
  rateLimiter?: RateLimiter;
  /** Limit for PostMind Core's calls to /api/studio/internal/**; absent = unlimited (tests). */
  internalRateLimiter?: RateLimiter;
  /** 15.E5: limit for public share-link requests (per client and per link); absent = unlimited. */
  publicRateLimiter?: RateLimiter;
  /** Phase 18: per-IP limit for provider webhooks (Resend, Stripe); absent = unlimited (tests). */
  webhookRateLimiter?: RateLimiter;
  /** Social publishing: publishers, credentials (takedown uses them synchronously). */
  publishing: PublishingDeps;
  oauthState: OAuthStateStore;
  /** Feature D: image library (ingest, generation, embeddings, search). */
  library: LibraryDeps;
  /** 13.13 ElevenLabs Instant Voice Cloning; absent (no ELEVENLABS_API_KEY) = 501. */
  voiceCloning?: VoiceCloningClient;
  /** Overlay fonts (<FamilyNoSpaces>.ttf) for previews; STUDIO_FONTS_BASE_URL. */
  fontsBaseUrl?: string;
  /** Public origin of Studio (OAuth return URLs must stay on it). */
  appUrl: string;
  /** 13.16: the shared provider circuit breaker (admin provider health); absent = in-memory. */
  breaker?: CircuitBreaker;
  /** 13.16: BullMQ queues for GET /admin/queues; absent = built from REDIS_URL on first use. */
  adminQueues?: () => InspectableQueue[];
  /** 15.D4: failed-job (dead-letter) handles per queue; absent = BullMQ from REDIS_URL. */
  deadLetterQueues?: () => DeadLetterQueue[];
  /** Core directories (13.34 / 13.35); absent = pending (501 until Core ships the endpoints). */
  core?: {
    businesses?: CoreBusinessDirectory;
    channels?: CoreChannelDirectory;
    /** 15.W1 Core content library; absent = pending (from-content answers 501). */
    content?: CoreContentClient;
  };
  /** 15.A3: thumbnail rendering + S3_BUCKET_THUMBNAILS; absent = FFmpeg + env on first use. */
  thumbnails?: { composer: ThumbnailComposer; bucket: string };
  /** 13.5: presigned upload URLs + ffprobe; absent = built from env on first use. */
  uploads?: UploadDeps;
  /** 14.11: beta "Plus for 30 days" override lookup; absent = Core's plan tier as-is (tests). */
  betaPlans?: BetaPlanLookup;
  // Phase 18 (plans/phase-18.md §0, §2) — optional so existing tests and core mode are
  // unchanged; each track fills its own field.
  /** The resolved integration modes (STUDIO_MODE and overrides); absent = read from env. */
  modes?: StudioModes;
  /** The identity provider behind resolveTenant (standalone Better Auth or core). */
  identity?: IdentityProvider;
  /** Tier / access per organisation (Track C); absent = no plan limits applied (tests). */
  entitlements?: EntitlementsReader;
  /** Stripe checkout / portal / invoices (Track C); absent = billing routes answer 501. */
  billing?: BillingService;
  /** Transactional email (Track B); absent = auth email is logged only (development). */
  mailer?: AuthMailer;
  /** Durable audit writes (auditLogDurable); absent = audit only through `audit`. */
  auditSink?: AuditSink;
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
  const rateLimit = await import('./rate-limit');
  const voices = await import('../providers/elevenlabs-voices');
  const adminHealth = await import('../services/admin-health');
  const beta = await import('../services/beta');
  const mailer = await import('../../email/mailer');
  const devTenant = devTenantFromEnv();
  if (devTenant) {
    logger.warn(
      { organisationId: devTenant.organisationId },
      'STUDIO_DEV_TENANT active: JWT verification is bypassed (next dev only)',
    );
  }
  const connection = redis.redisConnectionFromEnv();
  const queue = enqueue.createBullJobQueue(connection);
  // Reuse the worker wiring for publishing so API takedowns and workers share one code path.
  const pipeline = createDeps.createPipelineDeps({ db: prisma, queue });
  return {
    db: prisma,
    queue,
    storage: storage.getAssetStorage(),
    registry: registry.getProviderRegistry(),
    resolveTenant: devTenant ? async () => devTenant : tenant.requireTenantContext,
    audit: auditLog,
    idempotency: idempotency.createRedisIdempotencyStore(connection),
    rateLimiter: rateLimit.createRateLimiter(
      rateLimit.createRedisRateLimitStore(connection),
      rateLimit.rateLimitsFromEnv(),
      { onStoreError: (err) => logger.warn({ err }, 'rate limiter unavailable; failing open') },
    ),
    internalRateLimiter: rateLimit.createRateLimiter(
      rateLimit.createRedisRateLimitStore(connection),
      rateLimit.internalRateLimitsFromEnv(),
      { onStoreError: (err) => logger.warn({ err }, 'rate limiter unavailable; failing open') },
    ),
    publicRateLimiter: rateLimit.createRateLimiter(
      rateLimit.createRedisRateLimitStore(connection),
      rateLimit.publicRateLimitsFromEnv(),
      { onStoreError: (err) => logger.warn({ err }, 'rate limiter unavailable; failing open') },
    ),
    webhookRateLimiter: rateLimit.createRateLimiter(
      rateLimit.createRedisRateLimitStore(connection),
      rateLimit.webhookRateLimitsFromEnv(),
      { onStoreError: (err) => logger.warn({ err }, 'rate limiter unavailable; failing open') },
    ),
    publishing: pipeline.publishing,
    oauthState: oauthState.createRedisOAuthStateStore(connection),
    library: library.libraryDepsFrom(pipeline),
    voiceCloning: voices.voiceCloningFromEnv(),
    fontsBaseUrl: pipeline.config.fontsBaseUrl,
    appUrl: env.requireEnv('APP_URL'),
    breaker: pipeline.breaker,
    adminQueues: () => adminHealth.bullQueuesFor(connection),
    betaPlans: beta.createBetaPlanLookup({ db: prisma, logger, now: Date.now }),
    // Phase 18 §2.8: Resend through the outbox in standalone mode; logged only otherwise.
    mailer: mailer.createAuthMailer({ db: prisma, queue, logger }),
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
