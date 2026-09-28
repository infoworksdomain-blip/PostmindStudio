import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';

// BACKLOG 15.E4 — spec 18.5: "A public policy contact address (policy@postmind.ai) receives
// takedown and regulatory requests. Transparency report: annually publish counts of
// content-safety blocks, takedown requests received, and platform-mandated removals."
// Staff log what arrives (studio.takedown_requests); the report counts a calendar year (UTC).
//   content-safety blocks     projects stopped by a script-safety BLOCK or a content-safety BLOCK
//                             (errorReason script_safety_block / content_safety_block) plus staff
//                             BLOCK decisions in the review queue (safety_reviews, 13.17)
//   takedown requests         logged requests whose source is not a platform
//   platform-mandated removals logged requests whose source is a platform notice
// Project counts read the project's current failure: a project later regenerated successfully is
// no longer counted (documented in the report's notes).

export const TAKEDOWN_SOURCES = [
  'policy_mailbox',
  'platform',
  'regulator',
  'court',
  'other',
] as const;
export const TAKEDOWN_CATEGORIES = [
  'copyright',
  'privacy',
  'defamation',
  'safety',
  'impersonation',
  'regulatory',
  'other',
] as const;

export const createTakedownInput = z
  .object({
    receivedAt: z.iso.datetime(),
    source: z.enum(TAKEDOWN_SOURCES),
    category: z.enum(TAKEDOWN_CATEGORIES),
    requester: z.string().trim().min(1).max(200).optional(),
    reference: z.string().trim().min(1).max(200).optional(),
    organisationId: z.string().trim().min(1).max(128).optional(),
    publicationId: z.string().trim().min(1).max(64).optional(),
    summary: z.string().trim().min(1).max(4_000),
  })
  .strict();

export const resolveTakedownInput = z
  .object({
    state: z.enum(['ACTIONED', 'REJECTED']),
    resolutionNote: z.string().trim().min(1).max(4_000),
  })
  .strict();

export const listTakedownQuery = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  state: z.enum(['OPEN', 'ACTIONED', 'REJECTED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const transparencyQuery = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
});

type Db = PrismaClient;

function yearRange(year: number) {
  return { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) };
}

export async function createTakedownRequest(
  db: Db,
  staffUserId: string,
  input: z.infer<typeof createTakedownInput>,
) {
  if (input.publicationId) {
    const pub = await db.videoPublication.findUnique({
      where: { id: input.publicationId },
      select: { organisationId: true },
    });
    if (!pub) throw new ValidationError('publicationId does not exist');
    if (input.organisationId && pub.organisationId !== input.organisationId)
      throw new ValidationError('publicationId belongs to a different organisation');
    return db.takedownRequest.create({
      data: {
        ...input,
        organisationId: pub.organisationId,
        receivedAt: new Date(input.receivedAt),
        enteredByUserId: staffUserId,
      },
    });
  }
  return db.takedownRequest.create({
    data: { ...input, receivedAt: new Date(input.receivedAt), enteredByUserId: staffUserId },
  });
}

export async function listTakedownRequests(db: Db, query: z.infer<typeof listTakedownQuery>) {
  const where: Prisma.TakedownRequestWhereInput = {
    ...(query.year && { receivedAt: yearRange(query.year) }),
    ...(query.state && { state: query.state }),
  };
  return db.takedownRequest.findMany({
    where,
    orderBy: { receivedAt: 'desc' },
    take: query.limit,
  });
}

export async function resolveTakedownRequest(
  db: Db,
  staffUserId: string,
  id: string,
  input: z.infer<typeof resolveTakedownInput>,
  now: number,
) {
  const row = await db.takedownRequest.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Takedown request not found');
  if (row.state !== 'OPEN') throw new ConflictError(`Request is already ${row.state}`);
  return db.takedownRequest.update({
    where: { id },
    data: {
      state: input.state,
      resolutionNote: input.resolutionNote,
      resolvedByUserId: staffUserId,
      resolvedAt: new Date(now),
    },
  });
}

function countBy<T extends string>(rows: Array<Record<T, string>>, key: T) {
  const out: Record<string, number> = {};
  for (const row of rows) out[row[key]] = (out[row[key]] ?? 0) + 1;
  return out;
}

export interface TransparencyReport {
  year: number;
  generatedAt: string;
  contentSafetyBlocks: {
    total: number;
    scriptSafety: number;
    contentSafety: number;
    reviewQueue: number;
  };
  takedownRequests: {
    total: number;
    bySource: Record<string, number>;
    byCategory: Record<string, number>;
    byOutcome: Record<string, number>;
  };
  platformMandatedRemovals: { total: number; byCategory: Record<string, number> };
  notes: string[];
}

export async function transparencyReport(
  db: Db,
  year: number,
  now: number,
): Promise<TransparencyReport> {
  const range = yearRange(year);
  const [scriptBlocks, contentBlocks, reviewBlocks, requests] = await Promise.all([
    db.videoProject.count({
      where: { errorReason: { startsWith: 'script_safety_block' }, updatedAt: range },
    }),
    db.videoProject.count({
      where: { errorReason: { startsWith: 'content_safety_block' }, updatedAt: range },
    }),
    db.safetyReview.count({ where: { state: 'BLOCKED', decidedAt: range } }),
    db.takedownRequest.findMany({
      where: { receivedAt: range },
      select: { source: true, category: true, state: true },
    }),
  ]);
  const takedowns = requests.filter((r) => r.source !== 'platform');
  const platform = requests.filter((r) => r.source === 'platform');
  return {
    year,
    generatedAt: new Date(now).toISOString(),
    contentSafetyBlocks: {
      total: scriptBlocks + contentBlocks + reviewBlocks,
      scriptSafety: scriptBlocks,
      contentSafety: contentBlocks,
      reviewQueue: reviewBlocks,
    },
    takedownRequests: {
      total: takedowns.length,
      bySource: countBy(takedowns, 'source'),
      byCategory: countBy(takedowns, 'category'),
      byOutcome: countBy(takedowns, 'state'),
    },
    platformMandatedRemovals: { total: platform.length, byCategory: countBy(platform, 'category') },
    notes: [
      'Content-safety blocks count projects whose current failure is a safety block, plus staff BLOCK decisions in the review queue; a project later regenerated successfully is not counted.',
      'Takedown requests and platform-mandated removals are the requests PostMind staff logged from policy@postmind.ai and platform notices.',
    ],
  };
}
