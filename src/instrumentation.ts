// BACKLOG 11.6 — Sentry for the Next.js server (Next 15 instrumentation hook). Initialised only
// when SENTRY_DSN is set; without it the SDK is never started and reporting is a no-op.
// Uses PostMind's existing Sentry project (Engagement handover: SENTRY_DSN).

export async function register(): Promise<void> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (process.env.NEXT_RUNTIME !== 'nodejs' || !dsn) return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0) || 0,
    // No request bodies or user PII: Studio handles customer content and tokens.
    sendDefaultPii: false,
  });
}

export { captureRequestError as onRequestError } from '@sentry/nextjs';
