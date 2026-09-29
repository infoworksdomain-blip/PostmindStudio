import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { studioModes } from '../mode';
import type { JobQueue } from '../studio/queue/enqueue';
import { createConsoleAuthMailer, type AuthMailer } from './auth-mailer';
import { createEmailOutbox, type EmailOutbox } from './outbox';

// Phase 18 §2.8 — the production AuthMailer (Track 0 contract, auth-mailer.ts): every auth,
// organisation, billing and account email goes through the outbox and the send-email job
// (Resend). The idempotency key defaults to one per call; callers that can repeat (webhooks,
// retries) pass a stable key such as `auth:<verificationId>` or `billing:<stripeEventId>`.

export function createOutboxAuthMailer(outbox: EmailOutbox): AuthMailer {
  return {
    async sendAuthEmail(template, to, params, locale, options) {
      const result = await outbox.enqueue({
        idempotencyKey: options?.idempotencyKey ?? `${template}:${randomUUID()}`,
        to,
        template,
        locale,
        params,
        organisationId: options?.organisationId ?? null,
        userId: options?.userId ?? null,
      });
      return { queued: result.queued, suppressed: result.suppressed };
    },
  };
}

/**
 * The mailer for the configured email provider: Resend (outbox) when STUDIO_EMAIL_PROVIDER is
 * `resend` (the standalone default). Otherwise — core mode, where PostMind Core owns sign-in, or
 * `none` — auth mail is only logged (the console transport), which is correct for development
 * and for core mode, where Studio never sends auth mail.
 */
export function createAuthMailer(deps: {
  db: PrismaClient;
  queue?: JobQueue;
  logger: Logger;
  env?: Record<string, string | undefined>;
}): AuthMailer {
  if (studioModes(deps.env).email !== 'resend') return createConsoleAuthMailer(deps.logger);
  return createOutboxAuthMailer(
    createEmailOutbox({ db: deps.db, queue: deps.queue, logger: deps.logger }),
  );
}
