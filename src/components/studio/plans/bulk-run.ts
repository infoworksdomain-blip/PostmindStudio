'use client';

import { useCallback, useState } from 'react';

// BACKLOG 25.9 — bulk actions on a month plan. The API has no bulk item routes (content-plans has
// per-item regenerate / PATCH / DELETE and per-project approve), so a bulk action calls the same
// per-item route once per item, one after another (never in parallel: each call re-reads the plan
// and the allowance), reporting progress and ending with a summary of what worked and what did not.

export interface BulkProgress {
  done: number;
  total: number;
  failed: number;
}

export interface BulkResult<T> {
  ok: T[];
  failed: Array<{ item: T; error: unknown }>;
}

/** Runs `step` for each item in order; one failure never stops the rest. */
export async function runSequential<T>(
  items: readonly T[],
  step: (item: T) => Promise<unknown>,
  onProgress?: (progress: BulkProgress) => void,
): Promise<BulkResult<T>> {
  const result: BulkResult<T> = { ok: [], failed: [] };
  onProgress?.({ done: 0, total: items.length, failed: 0 });
  for (const item of items) {
    try {
      await step(item);
      result.ok.push(item);
    } catch (error) {
      result.failed.push({ item, error });
    }
    onProgress?.({
      done: result.ok.length + result.failed.length,
      total: items.length,
      failed: result.failed.length,
    });
  }
  return result;
}

/** A bulk run's progress for the screen (null when none is running). */
export function useBulkRun() {
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const run = useCallback(
    async <T>(items: readonly T[], step: (item: T) => Promise<unknown>): Promise<BulkResult<T>> => {
      try {
        return await runSequential(items, step, setProgress);
      } finally {
        setProgress(null);
      }
    },
    [],
  );
  return { progress, running: progress !== null, run };
}
