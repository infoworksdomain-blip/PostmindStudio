import type { PrismaClient } from '@prisma/client';
import { requireEnv } from '../../env';
import { logger } from '../../logger';
import { createKillSwitch, createPrismaFlagStore } from '../kill-switch';
import { createPrismaBudgetChecker, orgProviderDailyCapFromEnv } from '../providers/budget';
import { getCircuitBreaker } from '../providers/circuit-breaker';
import { getProviderRegistry } from '../providers/default-registry';
import { createPrismaProviderJobRepository } from '../providers/job-repository';
import type { JobQueue } from '../queue/enqueue';
import { assetsBucket, getAssetStorage } from '../storage';
import { DEFAULT_PIPELINE_TIMING, type PipelineDeps } from './deps';
import { createFfmpegInspector } from './media-probe';

// Production wiring for pipeline processors (workers and scripts).

export function createPipelineDeps(input: { db: PrismaClient; queue: JobQueue }): PipelineDeps {
  const breaker = getCircuitBreaker();
  const killSwitch = createKillSwitch({ store: createPrismaFlagStore(input.db) });
  return {
    db: input.db,
    registry: getProviderRegistry(),
    breaker,
    killSwitch,
    budget: createPrismaBudgetChecker(input.db, {
      orgProviderDailyCapPence: orgProviderDailyCapFromEnv(),
    }),
    tracking: { repo: createPrismaProviderJobRepository(input.db), killSwitch, breaker },
    queue: input.queue,
    storage: getAssetStorage(),
    media: createFfmpegInspector(),
    logger,
    config: {
      assetsBucket: assetsBucket(),
      rendersBucket: requireEnv('S3_BUCKET_RENDERS'),
      defaultVoiceId: process.env.ELEVENLABS_DEFAULT_VOICE_ID?.trim() || undefined,
      ...DEFAULT_PIPELINE_TIMING,
    },
    fetch: globalThis.fetch,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
