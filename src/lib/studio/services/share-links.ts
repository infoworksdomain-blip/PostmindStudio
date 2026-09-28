import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import type { AssetStorage } from '../storage';
import { findProject } from './projects';

// BACKLOG 15.E5 — smart-preview share links (spec 4.4: studio.postmind.ai "serves … public
// smart-preview links for approvals"). A link shows one project's variants (signed preview URLs)
// and takes feedback. Operator decision P8 (2026-09-28): external reviewers may VIEW and LEAVE
// FEEDBACK (name + optional email, rate-limited, shown on the Review screen, the project owner is
// notified) but can NOT approve — approval stays with signed-in members holding
// studio:project:approve.
// Security model:
//   - the token is 32 random bytes (base64url, 256 bits); only its SHA-256 is stored, so a
//     database leak does not leak working links, and the token is shown exactly once;
//   - expiry ≤ 7 days (168 h), revocable; expired, revoked, unknown and deleted-project links
//     are all the same 404 (nothing reveals whether a token ever existed);
//   - the public view carries the project name, the variants and the link's comments — never
//     organisation / business ids, costs, prompts, captions drafts or anything else;
//   - preview URLs are signed for at most PREVIEW_URL_TTL_SEC (and never beyond the link's expiry).

export const MAX_EXPIRY_HOURS = 168;
export const DEFAULT_EXPIRY_HOURS = 72;
export const PREVIEW_URL_TTL_SEC = 60 * 60;
export const MAX_COMMENTS_PER_LINK = 200;
export const MAX_ACTIVE_LINKS_PER_PROJECT = 20;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const createShareLinkInput = z
  .object({
    expiresInHours: z.number().int().min(1).max(MAX_EXPIRY_HOURS).default(DEFAULT_EXPIRY_HOURS),
  })
  .strict();

export const shareCommentInput = z
  .object({
    authorName: z.string().trim().min(1).max(80),
    /** Optional, so the team can reply; shown to the organisation only (decision P8). */
    authorEmail: z.email().max(254).optional(),
    body: z.string().trim().min(1).max(2_000),
  })
  .strict();

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newShareToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

type Db = PrismaClient;

function linkState(link: { expiresAt: Date; revokedAt: Date | null }, now: number) {
  if (link.revokedAt) return 'revoked' as const;
  return link.expiresAt.getTime() <= now ? ('expired' as const) : ('active' as const);
}

export async function createShareLink(
  deps: { db: Db; appUrl: string; now: () => number },
  scope: { organisationId: string; userId: string },
  projectId: string,
  input: z.infer<typeof createShareLinkInput>,
) {
  const project = await findProject(deps.db, scope.organisationId, projectId);
  const now = deps.now();
  const active = await deps.db.shareLink.count({
    where: { projectId: project.id, revokedAt: null, expiresAt: { gt: new Date(now) } },
  });
  if (active >= MAX_ACTIVE_LINKS_PER_PROJECT)
    throw new ConflictError(
      `A project can have at most ${MAX_ACTIVE_LINKS_PER_PROJECT} active share links; revoke one first`,
    );
  const token = newShareToken();
  const link = await deps.db.shareLink.create({
    data: {
      organisationId: scope.organisationId,
      projectId: project.id,
      tokenHash: hashShareToken(token),
      createdByUserId: scope.userId,
      expiresAt: new Date(now + input.expiresInHours * 60 * 60 * 1000),
    },
  });
  return {
    id: link.id,
    url: `${deps.appUrl.replace(/\/$/, '')}/p/${token}`,
    expiresAt: link.expiresAt.toISOString(),
    createdAt: link.createdAt.toISOString(),
    state: 'active' as const,
  };
}

/** The project's links (never their tokens) with every comment left through them. */
export async function listShareLinks(
  db: Db,
  organisationId: string,
  projectId: string,
  now: number,
) {
  const project = await findProject(db, organisationId, projectId);
  const links = await db.shareLink.findMany({
    where: { organisationId, projectId: project.id },
    orderBy: { createdAt: 'desc' },
    include: { comments: { orderBy: { createdAt: 'asc' } } },
    take: 100,
  });
  return links.map((l) => ({
    id: l.id,
    state: linkState(l, now),
    expiresAt: l.expiresAt.toISOString(),
    revokedAt: l.revokedAt?.toISOString() ?? null,
    createdAt: l.createdAt.toISOString(),
    createdByUserId: l.createdByUserId,
    viewCount: l.viewCount,
    lastViewedAt: l.lastViewedAt?.toISOString() ?? null,
    comments: l.comments.map((c) => ({
      id: c.id,
      authorName: c.authorName,
      authorEmail: c.authorEmail,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
    })),
  }));
}

export async function revokeShareLink(
  deps: { db: Db; now: () => number },
  scope: { organisationId: string; userId: string },
  projectId: string,
  linkId: string,
) {
  const link = await deps.db.shareLink.findFirst({
    where: { id: linkId, projectId, organisationId: scope.organisationId },
  });
  if (!link) throw new NotFoundError('Share link not found');
  if (link.revokedAt) return { id: link.id, revokedAt: link.revokedAt.toISOString() };
  const updated = await deps.db.shareLink.update({
    where: { id: link.id },
    data: { revokedAt: new Date(deps.now()), revokedByUserId: scope.userId },
  });
  return { id: updated.id, revokedAt: (updated.revokedAt as Date).toISOString() };
}

// ---------------------------------------------------------------- public side

/** C0 control characters other than tab, newline and carriage return. */
export function hasControlCharacters(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

const NOT_FOUND = 'This preview link is invalid or has expired';

/** The live link for a token, or the same 404 for every kind of miss. */
async function resolveLink(db: Db, token: string, now: number) {
  if (!TOKEN_PATTERN.test(token)) throw new NotFoundError(NOT_FOUND);
  const link = await db.shareLink.findUnique({ where: { tokenHash: hashShareToken(token) } });
  if (!link || linkState(link, now) !== 'active') throw new NotFoundError(NOT_FOUND);
  const project = await db.videoProject.findFirst({
    where: { id: link.projectId, organisationId: link.organisationId, deletedAt: null },
    select: { id: true, name: true, state: true, createdByUserId: true },
  });
  if (!project) throw new NotFoundError(NOT_FOUND);
  return { link, project };
}

export async function publicPreview(
  deps: { db: Db; storage: AssetStorage; now: () => number },
  token: string,
) {
  const now = deps.now();
  const { link, project } = await resolveLink(deps.db, token, now);
  const renders = await deps.db.videoRender.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      targetPlatform: true,
      aspectRatio: true,
      durationSec: true,
      s3Bucket: true,
      s3Key: true,
    },
  });
  // The newest render per platform is the variant under review.
  const latest = new Map<string, (typeof renders)[number]>();
  for (const r of renders) if (!latest.has(r.targetPlatform)) latest.set(r.targetPlatform, r);
  const ttl = Math.max(
    60,
    Math.min(PREVIEW_URL_TTL_SEC, Math.floor((link.expiresAt.getTime() - now) / 1000)),
  );
  const variants = await Promise.all(
    [...latest.values()].map(async (r) => ({
      id: r.id,
      platform: r.targetPlatform,
      aspectRatio: r.aspectRatio,
      durationSec: r.durationSec,
      videoUrl: await deps.storage.signedUrl(r.s3Bucket, r.s3Key, ttl),
    })),
  );
  await deps.db.shareLink.update({
    where: { id: link.id },
    data: { viewCount: { increment: 1 }, lastViewedAt: new Date(now) },
  });
  const comments = await deps.db.shareLinkComment.findMany({
    where: { shareLinkId: link.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, authorName: true, body: true, createdAt: true },
  });
  return {
    project: { name: project.name, state: project.state },
    variants,
    comments: comments.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
    expiresAt: link.expiresAt.toISOString(),
    canApprove: false,
  };
}

export async function addPublicComment(
  deps: { db: Db; now: () => number },
  token: string,
  input: z.infer<typeof shareCommentInput>,
) {
  const { link, project } = await resolveLink(deps.db, token, deps.now());
  const count = await deps.db.shareLinkComment.count({ where: { shareLinkId: link.id } });
  if (count >= MAX_COMMENTS_PER_LINK)
    throw new ConflictError('This preview link has reached its comment limit');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(input.authorName + input.body))
    throw new ValidationError('Comments may not contain control characters');
  const comment = await deps.db.shareLinkComment.create({
    data: {
      shareLinkId: link.id,
      organisationId: link.organisationId,
      projectId: project.id,
      authorName: input.authorName,
      authorEmail: input.authorEmail ?? null,
      body: input.body,
    },
  });
  return {
    comment: {
      id: comment.id,
      authorName: comment.authorName,
      body: comment.body,
      createdAt: comment.createdAt.toISOString(),
    },
    context: {
      organisationId: link.organisationId,
      projectId: project.id,
      projectName: project.name,
      ownerUserId: project.createdByUserId,
      shareLinkId: link.id,
    },
  };
}
