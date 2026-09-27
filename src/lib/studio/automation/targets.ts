import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ForbiddenError, ValidationError } from '../../errors';
import { hasCapability, StudioCapability } from '../../rbac';
import type { TenantContext } from '../../tenant';
import { PLATFORM_RULES } from '../platforms/rules';
import { PLATFORMS } from '../services/catalog';

// Auto-publish targets (spec 3 "auto-publish (on approval per template)", publishPolicy
// AUTO_ON_APPROVAL). Stored on the project as metadata.autoPublish = { targets } and on templates
// as publishDefaults.targets. The spec names the behaviour, not the shape: this shape is DERIVED
// from what POST /publications needs, so each target becomes exactly one such request.

/** 180 days in minutes, minus one: createPublication refuses schedules beyond 180 days. */
export const MAX_SCHEDULE_OFFSET_MINUTES = 180 * 24 * 60 - 1;
export const MAX_AUTO_PUBLISH_TARGETS = 10;

export const autoPublishTarget = z
  .object({
    platform: z.enum(PLATFORMS),
    /** Studio platform connection (TikTok, YouTube, X, LinkedIn). */
    connectionId: z.string().trim().min(1).max(64).optional(),
    /** Engagement channel account id (Instagram / Facebook). */
    platformAccountId: z.string().trim().min(1).max(128).optional(),
    caption: z.string().max(2_200).optional(),
    hashtags: z.array(z.string().max(100)).max(30).optional(),
    /** Publish this many minutes after approval (≥ 1); omitted = publish immediately. */
    scheduleOffsetMinutes: z.number().int().min(1).max(MAX_SCHEDULE_OFFSET_MINUTES).optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const rules = PLATFORM_RULES[t.platform];
    if (rules.credentials === 'studio' && !t.connectionId)
      ctx.addIssue({
        code: 'custom',
        path: ['connectionId'],
        message: `${t.platform} needs a connectionId`,
      });
    if (rules.credentials === 'meta' && !t.platformAccountId)
      ctx.addIssue({
        code: 'custom',
        path: ['platformAccountId'],
        message: `${t.platform} needs the Engagement platformAccountId`,
      });
  });

export type AutoPublishTarget = z.infer<typeof autoPublishTarget>;

export const autoPublishTargets = z.array(autoPublishTarget).max(MAX_AUTO_PUBLISH_TARGETS);

const reviewPolicy = z.enum(['AUTO_APPROVE', 'REQUIRE_APPROVAL', 'REQUIRE_APPROVAL_FROM_ROLE']);
const publishPolicy = z.enum(['MANUAL', 'SCHEDULED', 'AUTO_ON_APPROVAL']);

/** templates.publishDefaults (DERIVED column). */
export const publishDefaultsSchema = z
  .object({
    publishPolicy,
    reviewPolicy: reviewPolicy.optional(),
    targets: autoPublishTargets.default([]),
  })
  .strict();

export type PublishDefaults = z.infer<typeof publishDefaultsSchema>;

/** Targets stored on a project (metadata.autoPublish.targets); unreadable data → none. */
export function storedTargets(metadata: Prisma.JsonValue | null): AutoPublishTarget[] {
  const raw =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).autoPublish
      : undefined;
  const targets =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>).targets : undefined;
  const parsed = autoPublishTargets.safeParse(targets ?? []);
  return parsed.success ? parsed.data : [];
}

/** Parse a template's publishDefaults; malformed (hand-edited) rows are treated as absent. */
export function readPublishDefaults(value: Prisma.JsonValue | null): PublishDefaults | null {
  if (value === null) return null;
  const parsed = publishDefaultsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Setting auto-publish targets decides where a video will be posted, so it needs the same
 * capability as POST /publications — otherwise project:write alone could arrange a publication.
 */
export function assertMayConfigureTargets(
  tenant: Pick<TenantContext, 'capabilities'>,
  targets: AutoPublishTarget[],
): void {
  if (targets.length > 0 && !hasCapability(tenant, StudioCapability.PublicationWrite)) {
    throw new ForbiddenError(
      `Auto-publish targets need the ${StudioCapability.PublicationWrite} capability`,
      { capability: StudioCapability.PublicationWrite },
    );
  }
}

/**
 * Creation-time checks (400s): every target's platform is one of the project's formats and
 * every connection belongs to this organisation and platform. Publication-time checks (state,
 * quality, credentials, duplicates) are createPublication's, run again when the target fires.
 */
export async function validateTargets(
  db: Pick<PrismaClient, 'platformConnection'>,
  organisationId: string,
  targets: AutoPublishTarget[],
  formatPlatforms: readonly string[],
): Promise<void> {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [i, t] of targets.entries()) {
    if (!formatPlatforms.includes(t.platform))
      problems.push(`targets[${i}]: ${t.platform} is not one of the project's formats`);
    const key = `${t.platform}:${t.connectionId ?? t.platformAccountId ?? ''}`;
    if (seen.has(key)) problems.push(`targets[${i}]: duplicate target`);
    seen.add(key);
  }
  const ids = [...new Set(targets.flatMap((t) => (t.connectionId ? [t.connectionId] : [])))];
  const connections = ids.length
    ? await db.platformConnection.findMany({
        where: { id: { in: ids }, organisationId },
        select: { id: true, platform: true },
      })
    : [];
  const platformOf = new Map(connections.map((c) => [c.id, c.platform]));
  for (const [i, t] of targets.entries()) {
    if (!t.connectionId) continue;
    const expected = PLATFORM_RULES[t.platform].connectionPlatform;
    if (platformOf.get(t.connectionId) !== expected)
      problems.push(
        `targets[${i}]: connectionId is not a ${expected} connection in this organisation`,
      );
  }
  if (problems.length) throw new ValidationError('Auto-publish targets are invalid', { problems });
}
