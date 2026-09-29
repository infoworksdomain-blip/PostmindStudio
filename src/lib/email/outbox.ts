import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { isEmailTemplate, type EmailTemplate } from '../../emails/catalogue';
import { validateParams, type EmailParams } from '../../emails/params';
import { ValidationError } from '../errors';
import { DEFAULT_LOCALE, isLocale } from '../i18n/locales';
import { jobIds, type JobQueue } from '../studio/queue/enqueue';
import { isSuppressed, normaliseAddress } from './suppression';

// Phase 18 §2.8 — every email Studio sends is first a studio.email_outbox row, keyed by an
// idempotency key (`auth:<verificationId>`, `notification:<notificationId>:<userId>`, …), so a
// repeat never sends twice. The row is then handed to the `send-email` job (BullMQ, 5 retries);
// if the queue is unavailable the row stays `pending` and the outbox sweeper enqueues it later.
// Rendering and the Resend call happen in the worker (queue/workers/send-email.ts).
//
// States: pending → sending → sent → delivered | delayed | bounced | complained, or suppressed
// (the address is on the suppression list) or failed (gave up after retries / not retryable).

export const PLATFORM_ORGANISATION = 'postmind-platform';
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 254;
// Deliberately loose (one @, no spaces, a dot in the domain): Resend is the real validator.
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type OutboxDb = Pick<PrismaClient, 'emailOutbox' | 'emailSuppression'>;

export interface OutboxEmail {
  idempotencyKey: string;
  to: string;
  template: EmailTemplate;
  locale: string | null | undefined;
  params: EmailParams;
  organisationId?: string | null;
  userId?: string | null;
}

export interface EnqueueResult {
  id: string;
  /** false only when the address is suppressed (nothing will be sent). */
  queued: boolean;
  suppressed: boolean;
  /** true when the idempotency key was already recorded (nothing new was queued). */
  duplicate: boolean;
}

export interface EmailOutbox {
  enqueue(email: OutboxEmail): Promise<EnqueueResult>;
}

export function validateOutboxEmail(email: OutboxEmail): void {
  const problems: string[] = [];
  if (!isEmailTemplate(email.template)) problems.push(`unknown template ${email.template}`);
  const key = email.idempotencyKey.trim();
  if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    problems.push(`idempotencyKey must be 1–${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  const to = normaliseAddress(email.to);
  if (to.length > MAX_ADDRESS_LENGTH || !ADDRESS.test(to)) problems.push('to is not an address');
  if (problems.length > 0) throw new ValidationError('Invalid email', { problems });
  validateParams(email.template, email.params);
}

export function sendEmailJob(outboxId: string, organisationId: string | null | undefined) {
  return {
    organisationId: organisationId || PLATFORM_ORGANISATION,
    runId: outboxId,
    planTier: 'STANDARD' as const,
    outboxId,
  };
}

export function createEmailOutbox(deps: {
  db: OutboxDb;
  /** Absent = rows wait for the sweeper (e.g. a process without a queue connection). */
  queue?: JobQueue;
  logger: Logger;
}): EmailOutbox {
  async function schedule(id: string, organisationId: string | null | undefined): Promise<void> {
    if (!deps.queue) return;
    const data = sendEmailJob(id, organisationId);
    try {
      await deps.queue.add('send-email', data, { jobId: jobIds.sendEmail(data) });
    } catch (err) {
      // The row is the record: the sweeper (every 5 minutes) enqueues pending rows.
      deps.logger.warn({ err, outboxId: id }, 'email job not enqueued; the outbox sweeper retries');
    }
  }

  return {
    async enqueue(email) {
      validateOutboxEmail(email);
      const to = normaliseAddress(email.to);
      const suppressed = await isSuppressed(deps.db, to);
      const locale = isLocale(email.locale) ? email.locale : DEFAULT_LOCALE;
      const [created] = await deps.db.emailOutbox.createManyAndReturn({
        data: [
          {
            idempotencyKey: email.idempotencyKey.trim(),
            organisationId: email.organisationId ?? null,
            userId: email.userId ?? null,
            toAddress: to,
            template: email.template,
            locale,
            params: email.params as Prisma.InputJsonObject,
            state: suppressed ? 'suppressed' : 'pending',
          },
        ],
        skipDuplicates: true,
      });
      if (!created) {
        const existing = await deps.db.emailOutbox.findUniqueOrThrow({
          where: { idempotencyKey: email.idempotencyKey.trim() },
          select: { id: true, state: true, organisationId: true },
        });
        // A row left pending (its job was lost) is re-offered; the job id dedupes the rest.
        if (existing.state === 'pending') await schedule(existing.id, existing.organisationId);
        const isSuppressedRow = existing.state === 'suppressed';
        return {
          id: existing.id,
          queued: !isSuppressedRow,
          suppressed: isSuppressedRow,
          duplicate: true,
        };
      }
      if (suppressed) {
        deps.logger.info(
          { outboxId: created.id, template: email.template },
          'email not sent: the address is suppressed',
        );
        return { id: created.id, queued: false, suppressed: true, duplicate: false };
      }
      await schedule(created.id, email.organisationId);
      return { id: created.id, queued: true, suppressed: false, duplicate: false };
    },
  };
}
