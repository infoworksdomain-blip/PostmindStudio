import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { EngagementClient, EngagementTriggerFields } from '../platforms/publishing';

// BACKLOG 15.W5 — spec 16.3 (v1.1): "a Studio publication can trigger an Engagement automation
// from a new trigger type ON_VIDEO_PUBLISHED, e.g. 'when a video with hashtag #launch is
// published, DM everyone who liked it with a discount code.'" Engagement has not published the
// trigger contract, so this is Studio's PROPOSAL: the existing attribution call
// (POST {ENGAGEMENT_INTERNAL_URL}/api/engagement/internal/publications/attribute) gains a
// `trigger` object —
//   { "hashtags": ["launch"], "projectId": "prj_1", "projectTags": ["spring"],
//     "businessId": "biz_1", "sourceType": "BRIEF", "templateId": null,
//     "publishedAt": "2026-10-01T09:00:00.000Z" }
// — so Engagement can match hashtag / tag rules without calling Studio back. It is sent only when
// STUDIO_ENGAGEMENT_TRIGGER_FIELDS=true (default off: today's payload is unchanged until
// Engagement confirms the contract). projectTags come from video_projects.metadata.tags (strings)
// when present; Studio has no dedicated project-tag column.

export function triggerFieldsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.STUDIO_ENGAGEMENT_TRIGGER_FIELDS?.trim().toLowerCase() === 'true';
}

function stringTags(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const tags = (metadata as Record<string, unknown>).tags;
  return Array.isArray(tags)
    ? tags.filter((t): t is string => typeof t === 'string').slice(0, 50)
    : [];
}

/** The trigger fields for one publication, or null when it no longer exists. */
export async function loadTriggerFields(
  db: Pick<PrismaClient, 'videoPublication'>,
  publicationId: string,
  organisationId: string,
): Promise<EngagementTriggerFields | null> {
  const pub = await db.videoPublication.findFirst({
    where: { id: publicationId, organisationId },
    select: {
      hashtags: true,
      publishedAt: true,
      project: {
        select: { id: true, businessId: true, sourceType: true, templateId: true, metadata: true },
      },
    },
  });
  if (!pub) return null;
  return {
    hashtags: pub.hashtags.map((h) => h.replace(/^#/, '')),
    projectId: pub.project.id,
    projectTags: stringTags(pub.project.metadata),
    businessId: pub.project.businessId,
    sourceType: pub.project.sourceType,
    templateId: pub.project.templateId,
    publishedAt: pub.publishedAt?.toISOString() ?? null,
  };
}

/** Decorate the attribution client with trigger fields when the flag is on (else unchanged). */
export function withTriggerFields(
  inner: EngagementClient,
  deps: { db: Pick<PrismaClient, 'videoPublication'>; logger: Logger; enabled: boolean },
): EngagementClient {
  if (!deps.enabled) return inner;
  return {
    async attributePublication(body) {
      let trigger: EngagementTriggerFields | null = null;
      try {
        trigger = await loadTriggerFields(deps.db, body.publicationId, body.organisationId);
      } catch (err) {
        // Attribution must still happen; the trigger fields are an addition.
        deps.logger.warn({ err, publicationId: body.publicationId }, 'trigger fields unavailable');
      }
      await inner.attributePublication(trigger ? { ...body, trigger } : body);
    },
  };
}
