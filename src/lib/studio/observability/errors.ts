import { captureException, getClient } from '@sentry/core';

// BACKLOG 11.6 — report unexpected errors to Sentry when a client was initialised (API:
// src/instrumentation.ts; worker: scripts/worker.ts). Without SENTRY_DSN this is a no-op.
// Expected, user-facing errors (4xx StudioErrors) are never reported.

export function reportError(err: unknown, context: Record<string, unknown> = {}): void {
  if (!getClient()) return;
  captureException(err, { extra: context });
}
