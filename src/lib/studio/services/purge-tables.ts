import { Prisma, type PrismaClient } from '@prisma/client';
import { flagKeys } from '../system-flags';

// BACKLOG 14.1 — every studio table that holds an organisation's data, in FK-safe delete order
// (children before parents: prisma/schema.prisma relations video_analytics → video_publications
// → video_renders / video_projects, video_shots → video_scripts → video_projects, text_overlays
// → video_shots / slideshow_slides, ...). Each step selects the organisation's rows with a
// parameterised SQL predicate (the organisation id is always a bound parameter; table names are
// the constants below) and deletes them in batches, so a large organisation never holds one huge
// transaction and a crashed run resumes where it stopped (already-deleted rows are simply gone).
//
// Deliberately NOT deleted (the tombstone and audit trail):
//   - organisation_purges: the row records what was deleted, the counts and when;
//   - system_flags studio.frozenWorkspace.<org>: the workspace kill switch stays engaged so no
//     job can run for the deleted organisation;
//   - the audit trail itself lives in PostMind's audit service (src/lib/audit.ts), not here.
// purge-tables.test.ts fails when a model is added to the schema without being classified here.

type Sql = Prisma.Sql;

export interface PurgeTableStep {
  /** SQL table in the studio schema. */
  table: string;
  /** Prisma model name (the coverage test maps every model to a step or an exclusion). */
  model: string;
  /** Rows of `table` that belong to the organisation. */
  where: (organisationId: string) => Sql;
}

const t = (table: string) => Prisma.raw(`"studio"."${table}"`);
const byOrg = (org: string) => Prisma.sql`"organisationId" = ${org}`;
const orgProjects = (org: string) =>
  Prisma.sql`SELECT "id" FROM ${t('video_projects')} WHERE "organisationId" = ${org}`;
const orgPublications = (org: string) =>
  Prisma.sql`SELECT "id" FROM ${t('video_publications')} WHERE "organisationId" = ${org}
    OR "projectId" IN (${orgProjects(org)})`;
const orgScripts = (org: string) =>
  Prisma.sql`SELECT "id" FROM ${t('video_scripts')} WHERE "projectId" IN (${orgProjects(org)})`;
/** Business ids this organisation used, for the business-keyed image_library_queries cache. */
const orgBusinessIds = (org: string) =>
  Prisma.sql`SELECT "businessId" FROM ${t('business_profiles')} WHERE "organisationId" = ${org}
    UNION SELECT "businessId" FROM ${t('image_library')} WHERE "organisationId" = ${org}
    UNION SELECT "businessId" FROM ${t('website_scans')} WHERE "organisationId" = ${org}`;
const otherOrgBusinessIds = (org: string) =>
  Prisma.sql`SELECT "businessId" FROM ${t('business_profiles')} WHERE "organisationId" <> ${org}
    UNION SELECT "businessId" FROM ${t('image_library')} WHERE "organisationId" <> ${org}
    UNION SELECT "businessId" FROM ${t('website_scans')} WHERE "organisationId" <> ${org}
    UNION SELECT "businessId" FROM ${t('video_projects')} WHERE "organisationId" <> ${org}`;

const org = (table: string, model: string): PurgeTableStep => ({ table, model, where: byOrg });

export const PURGE_TABLE_STEPS: readonly PurgeTableStep[] = [
  {
    table: 'video_analytics',
    model: 'VideoAnalytic',
    where: (o) => Prisma.sql`"publicationId" IN (${orgPublications(o)})`,
  },
  {
    table: 'scheduled_publications',
    model: 'ScheduledPublication',
    where: (o) => Prisma.sql`"publicationId" IN (${orgPublications(o)})`,
  },
  {
    table: 'safety_audit_items',
    model: 'SafetyAuditItem',
    where: (o) => Prisma.sql`"organisationId" = ${o} OR "publicationId" IN (${orgPublications(o)})`,
  },
  org('auto_publish_outbox', 'AutoPublishOutbox'),
  {
    table: 'video_publications',
    model: 'VideoPublication',
    where: (o) => Prisma.sql`"organisationId" = ${o} OR "projectId" IN (${orgProjects(o)})`,
  },
  {
    table: 'text_overlays',
    model: 'TextOverlay',
    where: (o) => Prisma.sql`"shotId" IN (SELECT "id" FROM ${t('video_shots')}
        WHERE "scriptId" IN (${orgScripts(o)}))
      OR "renderId" IN (SELECT "id" FROM ${t('video_renders')} WHERE "projectId" IN (${orgProjects(o)}))
      OR "slideId" IN (SELECT "id" FROM ${t('slideshow_slides')} WHERE "projectId" IN (${orgProjects(o)}))`,
  },
  {
    table: 'slideshow_slides',
    model: 'SlideshowSlide',
    where: (o) => Prisma.sql`"projectId" IN (${orgProjects(o)})`,
  },
  {
    table: 'video_shots',
    model: 'VideoShot',
    where: (o) => Prisma.sql`"scriptId" IN (${orgScripts(o)})`,
  },
  {
    table: 'video_scripts',
    model: 'VideoScript',
    where: (o) => Prisma.sql`"projectId" IN (${orgProjects(o)})`,
  },
  {
    table: 'video_briefs',
    model: 'VideoBrief',
    where: (o) => Prisma.sql`"projectId" IN (${orgProjects(o)})`,
  },
  {
    table: 'approval_tasks',
    model: 'ApprovalTask',
    where: (o) => Prisma.sql`"projectId" IN (${orgProjects(o)})`,
  },
  org('content_safety_tasks', 'ContentSafetyTask'),
  org('safety_reviews', 'SafetyReview'),
  {
    table: 'video_renders',
    model: 'VideoRender',
    where: (o) => Prisma.sql`"projectId" IN (${orgProjects(o)})`,
  },
  org('video_assets', 'VideoAsset'),
  org('video_uploads', 'VideoUpload'),
  org('provider_jobs', 'ProviderJob'),
  org('provider_usage', 'ProviderUsage'),
  org('cost_alerts', 'CostAlert'),
  org('notifications', 'Notification'),
  org('notification_preferences', 'NotificationPreference'),
  org('onboarding_states', 'OnboardingState'),
  org('beta_feedback', 'BetaFeedback'),
  {
    // Project-level kill switches of the organisation's projects (not the workspace switch).
    table: 'system_flags',
    model: 'SystemFlag',
    where: (o) =>
      Prisma.sql`"key" IN (SELECT ${flagKeys.project('')} || "id" FROM ${t('video_projects')}
        WHERE "organisationId" = ${o})`,
  },
  org('video_projects', 'VideoProject'),
  org('style_memories', 'StyleMemory'),
  org('brand_kits', 'BrandKit'),
  org('voice_profiles', 'VoiceProfile'),
  org('templates', 'Template'),
  org('overlay_presets', 'OverlayPreset'),
  org('slideshow_templates', 'SlideshowTemplate'),
  {
    // Keyed by business id only: delete the cache rows of businesses no other org uses.
    table: 'image_library_queries',
    model: 'ImageLibraryQuery',
    where: (o) =>
      Prisma.sql`"businessId" IN (${orgBusinessIds(o)}) AND "businessId" NOT IN (${otherOrgBusinessIds(o)})`,
  },
  org('image_library', 'ImageLibraryItem'),
  org('website_scans', 'WebsiteScan'),
  org('domain_verifications', 'DomainVerification'),
  org('business_profiles', 'BusinessProfile'),
  org('platform_connections', 'PlatformConnection'),
  org('approval_workflows', 'ApprovalWorkflow'),
  org('org_policies', 'OrgPolicy'),
  org('org_cost_caps', 'OrgCostCap'),
  org('organisation_beta', 'OrganisationBeta'),
];

/** Models that are never purged: the tombstone, and platform-level data owned by no org. */
export const NOT_PURGED_MODELS: Readonly<Record<string, string>> = {
  OrganisationPurge: 'tombstone: records what was deleted and when',
  VideoLibraryItem: 'platform corpus (Feature A), not organisation data',
  VideoLibraryCategory: 'platform corpus taxonomy',
  VideoLibraryTag: 'platform corpus tags',
  VideoLibraryAnalysis: 'platform corpus analysis',
  VideoLibraryEmbedding: 'platform corpus embeddings',
  VideoLibraryLicense: 'platform corpus licences',
  VideoLibraryIngestRun: 'platform corpus ingest runs (staff)',
};

/** Rows of one step that belong to the organisation. */
export async function countRows(
  db: PrismaClient,
  step: PurgeTableStep,
  organisationId: string,
): Promise<number> {
  const rows = await db.$queryRaw<{ n: number }[]>(
    Prisma.sql`SELECT count(*)::int AS n FROM ${t(step.table)} WHERE ${step.where(organisationId)}`,
  );
  return rows[0]?.n ?? 0;
}

/**
 * Deletes at most `limit` of the organisation's rows of one step; returns how many went. Rows are
 * addressed by ctid (Postgres's physical row id) because several tables have no "id" column
 * (composite or organisation-keyed primary keys, system_flags keyed by "key").
 */
export async function deleteBatch(
  db: PrismaClient,
  step: PurgeTableStep,
  organisationId: string,
  limit: number,
): Promise<number> {
  return db.$executeRaw(
    Prisma.sql`DELETE FROM ${t(step.table)} WHERE ctid IN (
      SELECT ctid FROM ${t(step.table)} WHERE ${step.where(organisationId)} LIMIT ${limit})`,
  );
}
