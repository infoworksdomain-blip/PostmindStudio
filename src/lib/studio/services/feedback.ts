import type { BetaFeedback, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError, RateLimitError } from '../../errors';

// BACKLOG 14.11 — in-app feedback from the app shell's Feedback button.
//   POST /api/studio/feedback { kind, message ≤ 2000, projectId?, screen }  (any signed-in user)
//   GET  /api/studio/admin/feedback?kind&organisationId&cohort&since&limit&cursor  (staff)
// Rate limit: FEEDBACK_PER_HOUR per user, counted from the table itself (so it holds across
// instances without Redis), on top of the general per-user API limit.

export const FEEDBACK_KINDS = ['bug', 'idea', 'praise', 'other'] as const;
export const FEEDBACK_MESSAGE_MAX = 2_000;
export const FEEDBACK_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

export const feedbackInput = z
  .object({
    kind: z.enum(FEEDBACK_KINDS),
    message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX),
    projectId: z.string().trim().min(1).max(64).optional(),
    /** The app path the user was on, e.g. "/projects/abc/review". */
    screen: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^\/[\w\-/.?=&%]*$/, 'must be an app path starting with /'),
  })
  .strict();

export type FeedbackInput = z.infer<typeof feedbackInput>;

export const listFeedbackQuery = z.object({
  kind: z.enum(FEEDBACK_KINDS).optional(),
  organisationId: z.string().trim().min(1).max(128).optional(),
  cohort: z.string().trim().min(1).max(64).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(64).optional(),
});

export type ListFeedbackQuery = z.infer<typeof listFeedbackQuery>;

type FeedbackDb = Pick<PrismaClient, 'betaFeedback' | 'videoProject' | 'organisationBeta'>;

export function viewFeedback(row: BetaFeedback) {
  return {
    id: row.id,
    organisationId: row.organisationId,
    userId: row.userId,
    kind: row.kind,
    message: row.message,
    projectId: row.projectId,
    screen: row.screen,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function submitFeedback(
  db: FeedbackDb,
  actor: { organisationId: string; userId: string },
  input: FeedbackInput,
  now: number,
): Promise<ReturnType<typeof viewFeedback>> {
  const windowStart = new Date(now - HOUR_MS);
  const recent = await db.betaFeedback.findMany({
    where: {
      organisationId: actor.organisationId,
      userId: actor.userId,
      createdAt: { gte: windowStart },
    },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
    take: FEEDBACK_PER_HOUR,
  });
  if (recent.length >= FEEDBACK_PER_HOUR) {
    const oldest = recent[0]?.createdAt.getTime() ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000));
    throw new RateLimitError(
      `At most ${FEEDBACK_PER_HOUR} feedback messages an hour; thank you — try again later`,
      retryAfterSec,
    );
  }
  if (input.projectId) {
    const project = await db.videoProject.findFirst({
      where: { id: input.projectId, organisationId: actor.organisationId, deletedAt: null },
      select: { id: true },
    });
    if (!project) throw new NotFoundError('Project not found');
  }
  const row = await db.betaFeedback.create({
    data: {
      organisationId: actor.organisationId,
      userId: actor.userId,
      kind: input.kind,
      message: input.message,
      projectId: input.projectId ?? null,
      screen: input.screen,
    },
  });
  return viewFeedback(row);
}

export async function listFeedback(db: FeedbackDb, query: ListFeedbackQuery) {
  let organisationIds: string[] | undefined;
  if (query.cohort) {
    const members = await db.organisationBeta.findMany({
      where: { cohort: query.cohort },
      select: { organisationId: true },
    });
    organisationIds = members.map((m) => m.organisationId);
  }
  if (query.organisationId)
    organisationIds = organisationIds
      ? organisationIds.filter((id) => id === query.organisationId)
      : [query.organisationId];
  const rows = await db.betaFeedback.findMany({
    where: {
      ...(query.kind && { kind: query.kind }),
      ...(organisationIds && { organisationId: { in: organisationIds } }),
      ...(query.since && { createdAt: { gte: new Date(query.since) } }),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
  });
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  return {
    data: page.map(viewFeedback),
    hasMore,
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  };
}
