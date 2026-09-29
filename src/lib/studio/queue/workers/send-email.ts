import type { Prisma } from '@prisma/client';
import { isEmailTemplate, isUnsubscribable, SECRET_PARAMS } from '../../../../emails/catalogue';
import type { EmailParams } from '../../../../emails/params';
import { renderEmail } from '../../../../emails/render';
import { emailSendConfigFromEnv } from '../../../email/config';
import { sendEmailJob } from '../../../email/outbox';
import { createResendTransport } from '../../../email/resend-client';
import { isSuppressed } from '../../../email/suppression';
import { NotFoundError, ValidationError } from '../../../errors';
import { NOTIFICATION_KINDS, type NotificationKind } from '../../notifications/notifier';
import { signUnsubscribeToken, unsubscribeUrl } from '../../notifications/unsubscribe';
import type { EmailDeliveryDeps, PipelineDeps } from '../../pipeline/deps';
import { jobIds } from '../enqueue';
import type { JobDataMap } from '../queues';

// Phase 18 §2.8 — the `send-email` job: render one studio.email_outbox row in the recipient's
// locale and send it through Resend with the row's idempotency key (Idempotency-Key header), so
// a retried job never delivers twice. Retries follow the queue policy (5 retries, 5 s → 2 min);
// 429 / 5xx / network errors retry, anything else fails the row at once. A suppressed address is
// never sent to. Once sent, one-time links (`url`) are removed from the stored params.
//
// Notification mail gets RFC 8058 one-click unsubscribe headers
// (List-Unsubscribe: <https://…/api/email/unsubscribe?token=…>, List-Unsubscribe-Post:
// List-Unsubscribe=One-Click) and the same link in the footer. Auth, billing and account mail
// has neither.

/** Rows the job still has to send; every other state is final or owned by the webhook. */
const SENDABLE = new Set(['pending', 'sending']);
const SWEEP_PENDING_AFTER_MS = 5 * 60_000;
const SWEEP_SENDING_AFTER_MS = 15 * 60_000;
const SWEEP_BATCH = 200;
export const EMAIL_OUTBOX_RETENTION_DAYS = 90;
/** Every 5 minutes (worker.ts scheduler). */
export const EMAIL_SWEEP_SCHEDULE = '*/5 * * * *';

const deliveryCache = new WeakMap<object, EmailDeliveryDeps>();

function deliveryFor(deps: PipelineDeps): EmailDeliveryDeps {
  if (deps.email) return deps.email;
  let delivery = deliveryCache.get(deps);
  if (!delivery) {
    const config = emailSendConfigFromEnv();
    delivery = { config, transport: createResendTransport({ apiKey: config.apiKey }) };
    deliveryCache.set(deps, delivery);
  }
  return delivery;
}

function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

function redacted(params: EmailParams): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, SECRET_PARAMS.has(k) ? '[sent]' : v]),
  );
}

export async function sendEmail(data: JobDataMap['send-email'], deps: PipelineDeps): Promise<void> {
  const log = deps.logger.child({ outboxId: data.outboxId });
  const row = await deps.db.emailOutbox.findUnique({ where: { id: data.outboxId } });
  if (!row) throw new NotFoundError(`email outbox row ${data.outboxId} not found`);
  if (!SENDABLE.has(row.state)) return;
  if (!isEmailTemplate(row.template)) {
    throw new ValidationError(`unknown email template ${row.template}`);
  }
  if (await isSuppressed(deps.db, row.toAddress)) {
    await deps.db.emailOutbox.update({ where: { id: row.id }, data: { state: 'suppressed' } });
    log.info({ template: row.template }, 'email not sent: the address is suppressed');
    return;
  }
  const { config, transport } = deliveryFor(deps);
  const params = (row.params ?? {}) as EmailParams;

  let unsubscribe: string | undefined;
  if (isUnsubscribable(row.template) && row.userId && row.organisationId) {
    if (!isNotificationKind(params.kind)) {
      throw new ValidationError(`notification email ${row.id} has no valid kind`);
    }
    const token = signUnsubscribeToken(
      { userId: row.userId, organisationId: row.organisationId, kind: params.kind },
      config.unsubscribeSecret,
    );
    unsubscribe = unsubscribeUrl(config.appUrl, token);
  }

  const rendered = await renderEmail({
    template: row.template,
    params,
    locale: row.locale,
    appUrl: config.appUrl,
    ...(config.supportEmail && { supportEmail: config.supportEmail }),
    ...(unsubscribe && { unsubscribeUrl: unsubscribe }),
  });

  await deps.db.emailOutbox.update({
    where: { id: row.id },
    data: { state: 'sending', attempts: { increment: 1 } },
  });
  try {
    const result = await transport.send({
      from: config.from,
      to: row.toAddress,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      ...(config.replyTo && { replyTo: config.replyTo }),
      ...(unsubscribe && {
        headers: {
          'List-Unsubscribe': `<${unsubscribe}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
      tags: [{ name: 'template', value: row.template }],
      idempotencyKey: row.idempotencyKey,
    });
    await deps.db.emailOutbox.update({
      where: { id: row.id },
      data: {
        state: 'sent',
        providerMessageId: result.id,
        sentAt: new Date(deps.now()),
        lastError: result.alreadySent ? 'idempotency key already used: sent earlier' : null,
        params: redacted(params),
      },
    });
    log.info({ template: row.template, locale: rendered.locale }, 'email sent');
  } catch (err) {
    await deps.db.emailOutbox.update({
      where: { id: row.id },
      data: {
        state: 'pending',
        lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      },
    });
    throw err;
  }
}

/** Final failure (retries used up, or not retryable): the row is failed, and so is its notification. */
export async function onSendEmailFailed(
  data: JobDataMap['send-email'],
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  const row = await deps.db.emailOutbox.findUnique({
    where: { id: data.outboxId },
    select: { id: true, idempotencyKey: true, state: true },
  });
  if (!row || !SENDABLE.has(row.state)) return;
  await deps.db.emailOutbox.update({
    where: { id: row.id },
    data: { state: 'failed', lastError: reason.slice(0, 500) },
  });
  const notificationId = /^notification:([^:]+):/.exec(row.idempotencyKey)?.[1];
  if (notificationId) {
    await deps.db.notification.updateMany({
      where: { id: notificationId },
      data: { emailStatus: 'failed' },
    });
  }
  deps.logger.error({ outboxId: row.id, reason }, 'email failed');
}

/**
 * Every 5 minutes: re-enqueue rows whose job was lost (pending > 5 min, or stuck sending
 * > 15 min; the job id dedupes rows still queued), and delete finished rows older than
 * EMAIL_OUTBOX_RETENTION_DAYS (they hold the recipient's address).
 */
export async function sweepEmailOutbox(
  _data: JobDataMap['sweep-email-outbox'],
  deps: PipelineDeps,
): Promise<void> {
  const now = deps.now();
  const stale = await deps.db.emailOutbox.findMany({
    where: {
      OR: [
        { state: 'pending', updatedAt: { lt: new Date(now - SWEEP_PENDING_AFTER_MS) } },
        { state: 'sending', updatedAt: { lt: new Date(now - SWEEP_SENDING_AFTER_MS) } },
      ],
    },
    select: { id: true, organisationId: true },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_BATCH,
  });
  for (const row of stale) {
    const job = sendEmailJob(row.id, row.organisationId);
    await deps.queue.add('send-email', job, { jobId: jobIds.sendEmail(job) });
  }
  const { count: purged } = await deps.db.emailOutbox.deleteMany({
    where: {
      state: { notIn: [...SENDABLE] },
      createdAt: { lt: new Date(now - EMAIL_OUTBOX_RETENTION_DAYS * 24 * 60 * 60_000) },
    },
  });
  if (stale.length > 0 || purged > 0) {
    deps.logger.info({ requeued: stale.length, purged }, 'email outbox swept');
  }
}

export async function onSweepEmailOutboxFailed(
  _data: JobDataMap['sweep-email-outbox'],
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  deps.logger.error({ reason }, 'email outbox sweep failed');
}
