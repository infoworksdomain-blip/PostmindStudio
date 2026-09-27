import type { PipelineDeps } from '../../pipeline/deps';
import { buildStyleMemories } from '../../services/style-memory';
import type { RollUpJobData } from '../queues';

// BACKLOG 13.29 — nightly style-memory build (spec 10.3 / 15.3), platform-level, on the analytics
// queue at 03:15 UTC (after the 02:15 analytics roll-up, so retention is fresh).

export const STYLE_MEMORY_SCHEDULE = '15 3 * * *';

export async function buildStyleMemoryJob(data: RollUpJobData, deps: PipelineDeps): Promise<void> {
  const result = await buildStyleMemories(deps.db, deps.now());
  deps.logger.info({ ...result, runId: data.runId }, 'style memory rebuilt');
}

export async function onBuildStyleMemoryFailed(
  data: RollUpJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  deps.logger.error({ runId: data.runId, reason }, 'style memory build failed');
}
