import type { PipelineDeps } from '../../pipeline/deps';
import { failExport, runDataExport } from '../../services/export';
import type { ExportJobData } from '../queues';

// BACKLOG 15.E1 — build one organisation's data export (services/export.ts). On the final failed
// attempt the export is marked FAILED, which also frees the one-export-at-a-time slot.

export async function exportAccountData(data: ExportJobData, deps: PipelineDeps): Promise<void> {
  await runDataExport(
    {
      db: deps.db,
      storage: deps.storage,
      logger: deps.logger,
      now: deps.now,
      assetsBucket: deps.config.assetsBucket,
    },
    data.exportId,
  );
}

export async function onExportAccountDataFailed(
  data: ExportJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  await failExport(deps.db, data.exportId, reason);
  deps.logger.error({ exportId: data.exportId, reason }, 'data export failed');
}
