import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { isUnkeptBlitz } from '../blitz/constants';
import { currentRunId } from '../pipeline/project-state';
import { notifierFor, notifySafely, type Notifier } from './notifier';
import { projectLabel, projectNameParam } from '../../project-name';

// Spec 14.4 events: generation complete, publication failed (with a retry link), approval
// required after 2 hours. Each helper is called from the worker that owns the event and never
// throws into it.

type Host = { db: PrismaClient; logger: Logger; notifier?: Notifier; now: () => number };

export const APPROVAL_PENDING_AFTER_MS = 2 * 60 * 60 * 1000;
/** Projects waiting longer than this are no longer scanned (they were notified long ago). */
export const APPROVAL_SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const APPROVAL_SCAN_LIMIT = 500;

/** Run an event hook without ever failing the worker that raised the event. */
async function safely(host: Host, event: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    host.logger.error({ err, event }, 'notification event failed');
  }
}

/** READY_FOR_REVIEW reached (or auto-approved straight after): tell the creator. */
export function notifyGenerationComplete(
  host: Host,
  input: { projectId: string; organisationId: string; runId: string },
): Promise<void> {
  return safely(host, 'generation_complete', () => generationComplete(host, input));
}

async function generationComplete(
  host: Host,
  input: { projectId: string; organisationId: string; runId: string },
): Promise<void> {
  const project = await host.db.videoProject.findFirst({
    where: { id: input.projectId, organisationId: input.organisationId },
    select: { name: true, state: true, createdByUserId: true, metadata: true },
  });
  // 22.4: a Blitz card rendered ahead of a swipe is not "ready for review" yet.
  if (!project || isUnkeptBlitz(project.metadata)) return;
  const autoApproved = project.state === 'APPROVED' || project.state === 'PUBLISHING';
  await notifySafely(host, {
    organisationId: input.organisationId,
    userId: project.createdByUserId,
    kind: 'generation_complete',
    title: autoApproved
      ? `“${projectLabel(project.name)}” is ready and was auto-approved`
      : `“${projectLabel(project.name)}” is ready for review`,
    body: autoApproved
      ? 'The video passed every quality check and your review policy approved it automatically.'
      : 'Every variant passed the quality checks. Review it, then approve or publish.',
    link: `/projects/${input.projectId}`,
    dedupeKey: `generation_complete:${input.projectId}:${input.runId}`,
    message: {
      key: autoApproved ? 'generationAutoApproved' : 'generationReady',
      params: { name: projectNameParam(project.name) },
    },
  });
}

type PublicationFailure = {
  publicationId: string;
  organisationId: string;
  projectId: string;
  reason: string;
};

/** A publication failed for good (after retries): tell the creator, with the retry link. */
export function notifyPublicationFailed(host: Host, input: PublicationFailure): Promise<void> {
  return safely(host, 'publication_failed', () => publicationFailed(host, input));
}

async function publicationFailed(host: Host, input: PublicationFailure): Promise<void> {
  const publication = await host.db.videoPublication.findFirst({
    where: { id: input.publicationId, organisationId: input.organisationId },
    select: {
      platform: true,
      retryCount: true,
      project: { select: { name: true, createdByUserId: true } },
    },
  });
  if (!publication) return;
  await notifySafely(host, {
    organisationId: input.organisationId,
    userId: publication.project.createdByUserId,
    kind: 'publication_failed',
    title: `Publishing “${projectLabel(publication.project.name)}” to ${publication.platform} failed`,
    body: `${input.reason.slice(0, 500)} — open the project to retry.`,
    link: `/projects/${input.projectId}`,
    // One per failure: retryCount was incremented by the failure being reported.
    dedupeKey: `publication_failed:${input.publicationId}:${publication.retryCount}`,
    message: {
      key: 'publicationFailed',
      params: {
        name: projectNameParam(publication.project.name),
        platform: publication.platform,
        reason: input.reason.slice(0, 500),
      },
    },
  });
}

type DraftSent = { publicationId: string; organisationId: string; projectId: string };

/** English body of the 22.7 notification (the app renders notifications.tiktokDraftSent). */
export const TIKTOK_DRAFT_SENT_BODY =
  'Open the TikTok app, add a trending sound, finish posting from the notification, and keep the "AI-generated content" label switched on.';

/**
 * 22.7: a TikTok post went to the creator's TikTok inbox (drafts chosen, or the 15.A2 fallback):
 * it is not live until they finish it in the app, so say so, with the AI-label reminder.
 */
export function notifyTikTokDraftSent(host: Host, input: DraftSent): Promise<void> {
  return safely(host, 'tiktok_draft', () => tiktokDraftSent(host, input));
}

async function tiktokDraftSent(host: Host, input: DraftSent): Promise<void> {
  const publication = await host.db.videoPublication.findFirst({
    where: { id: input.publicationId, organisationId: input.organisationId },
    select: { project: { select: { name: true, createdByUserId: true } } },
  });
  if (!publication) return;
  await notifySafely(host, {
    organisationId: input.organisationId,
    userId: publication.project.createdByUserId,
    kind: 'tiktok_draft',
    title: `“${projectLabel(publication.project.name)}” is in your TikTok drafts`,
    body: TIKTOK_DRAFT_SENT_BODY,
    link: `/projects/${input.projectId}`,
    dedupeKey: `tiktok_draft:${input.publicationId}`,
    message: {
      key: 'tiktokDraftSent',
      params: { name: projectNameParam(publication.project.name) },
    },
  });
}

/**
 * Scheduled check (every 15 minutes): projects waiting in READY_FOR_REVIEW for more than two
 * hours get one "approval required" notification per run.
 */
export async function notifyPendingApprovals(host: Host): Promise<{ notified: number }> {
  const now = host.now();
  const projects = await host.db.videoProject.findMany({
    where: {
      state: 'READY_FOR_REVIEW',
      deletedAt: null,
      completedAt: {
        lte: new Date(now - APPROVAL_PENDING_AFTER_MS),
        gte: new Date(now - APPROVAL_SCAN_WINDOW_MS),
      },
    },
    select: {
      id: true,
      organisationId: true,
      name: true,
      createdByUserId: true,
      metadata: true,
      completedAt: true,
    },
    orderBy: { completedAt: 'asc' },
    take: APPROVAL_SCAN_LIMIT,
  });
  const notifier = notifierFor(host);
  let notified = 0;
  for (const project of projects) {
    if (isUnkeptBlitz(project.metadata)) continue;
    const runId = currentRunId(project) ?? 'unknown';
    try {
      const { created } = await notifier.notify({
        organisationId: project.organisationId,
        // Org-wide: approvers are usually not the creator (studio:project:approve).
        userId: null,
        kind: 'approval_pending',
        title: `“${projectLabel(project.name)}” is waiting for approval`,
        body: 'It has been ready for review for more than 2 hours.',
        link: `/projects/${project.id}`,
        dedupeKey: `approval_pending:${project.id}:${runId}`,
        message: { key: 'approvalPending', params: { name: projectNameParam(project.name) } },
      });
      if (created) notified += 1;
    } catch (err) {
      host.logger.error({ err, projectId: project.id }, 'approval reminder failed');
    }
  }
  return { notified };
}
