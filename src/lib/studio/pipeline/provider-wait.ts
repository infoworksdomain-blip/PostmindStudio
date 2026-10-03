import type { PrismaClient } from '@prisma/client';
import { mergeProjectMetadata } from './project-state';

// 20.29 (load test) — when a project's work waits for a busy provider (a 15.C3 rate window, a
// 20.29 concurrency cap or a provider's own "too many requests"), the job is delayed rather than
// failed. The project records the last wait as metadata.providerWait { at, retryAt } so the
// project page can say "Queued: your video starts soon" instead of looking stuck. No provider
// name is stored: customers never see which provider is busy (20.11).

export const PROVIDER_WAIT_KEY = 'providerWait';

export interface ProviderWait {
  /** ISO time the wait was recorded. */
  at: string;
  /** ISO time the job asks for the provider again. */
  retryAt: string;
}

export async function noteProviderWait(
  deps: { db: Pick<PrismaClient, '$executeRaw'>; now: () => number },
  data: { projectId?: string; runId: string },
  retryAfterMs: number,
): Promise<boolean> {
  if (!data.projectId) return false;
  const at = deps.now();
  const wait: ProviderWait = {
    at: new Date(at).toISOString(),
    retryAt: new Date(at + retryAfterMs).toISOString(),
  };
  return mergeProjectMetadata(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    patch: { [PROVIDER_WAIT_KEY]: wait },
  });
}
