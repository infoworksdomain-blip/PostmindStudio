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
// Deliberately NOT deleted (the tombstones, the legal record and the audit trail):
//   - organisation_purges: the row records what was deleted, the counts and when;
//   - business_purges (15.E2): the per-business tombstones, same reason;
//   - takedown_requests (15.D, transparency): the legal / transparency-report record of a
//     takedown survives the organisation, but ANONYMISE_STEPS clears its personal fields
//     (requester) and its link to the deleted publication;
//   - system_flags studio.frozenWorkspace.<org>: the workspace kill switch stays engaged so no
//     job can run for the deleted organisation;
//   - the audit trail: PostMind's audit service in core mode; in standalone mode studio.audit_log
//     (append-only, ids only) ages out through the audit-retention job instead;
//   - the Stripe billing record (billing_customers, subscriptions, trial_fingerprints,
//     stripe_events) and the per-user identity tables (they go with account deletion).
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
  // Phase 15: rows keyed by publication id (no FK), removed while the publications still exist.
  org('publication_conversations', 'PublicationConversation'),
  org('calendar_shadows', 'CalendarShadow'),
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
  // Phase 15 organisation data. share_link_comments before share_links (FK).
  org('share_link_comments', 'ShareLinkComment'),
  org('share_links', 'ShareLink'),
  org('data_exports', 'DataExport'),
  org('usage_events', 'UsageEvent'),
  org('drip_queues', 'DripQueue'),
  // Phase 18 §2.11: the organisation's own businesses (standalone mode).
  org('businesses', 'Business'),
  // BYOC API keys (envelope-encrypted): a deleted organisation's credentials must not survive.
  org('provider_credentials', 'ProviderCredential'),
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
  // Phase 18 Track C: top-up credits and entitlements are organisation data (uses before credits).
  org('usage_credit_uses', 'UsageCreditUse'),
  org('usage_credits', 'UsageCredit'),
  org('org_entitlements', 'OrgEntitlement'),
  // Phase 18 §2.8: the organisation's queued / sent emails (addresses and one-time links).
  org('email_outbox', 'EmailOutbox'),
  // Phase 18 identity (Better Auth tables, "organizationId" spelling): memberships and pending
  // invitations, then the organisation row itself last, after every child that references it
  // (members / invitations have FKs to organisations; nothing else does).
  {
    table: 'members',
    model: 'Member',
    where: (o) => Prisma.sql`"organizationId" = ${o}`,
  },
  {
    table: 'invitations',
    model: 'Invitation',
    where: (o) => Prisma.sql`"organizationId" = ${o}`,
  },
  {
    table: 'organisations',
    model: 'Organization',
    where: (o) => Prisma.sql`"id" = ${o}`,
  },
];

/** Models that are never purged: the tombstones, the takedown record, platform-level data. */
export const NOT_PURGED_MODELS: Readonly<Record<string, string>> = {
  OrganisationPurge: 'tombstone: records what was deleted and when',
  BusinessPurge: 'tombstone: records which business was deleted, the counts and when',
  TakedownRequest:
    'legal / transparency record: kept, personal fields anonymised (ANONYMISE_STEPS)',
  VideoLibraryItem: 'platform corpus (Feature A), not organisation data',
  VideoLibraryCategory: 'platform corpus taxonomy',
  VideoLibraryTag: 'platform corpus tags',
  VideoLibraryAnalysis: 'platform corpus analysis',
  VideoLibraryEmbedding: 'platform corpus embeddings',
  VideoLibraryLicense: 'platform corpus licences',
  VideoLibraryIngestRun: 'platform corpus ingest runs (staff)',
  // Phase 18 Track C (§5.11: Stripe invoices are kept for UK legal retention; these rows hold
  // Stripe ids and statuses only, no personal data, and link the kept invoices to the org).
  BillingCustomer: 'billing record: Stripe customer id, marked deleted (§5.11 retention)',
  Subscription: 'billing record: Stripe subscription ids and statuses (§5.11 retention)',
  TrialFingerprint: 'abuse control: card fingerprints that already had a trial',
  StripeEvent: 'platform webhook dedupe log (no organisation column)',
  // Phase 18 identity: per-user rows go with account deletion (§2.4), not with an organisation.
  User: 'per-user account: removed by account deletion, not by an organisation purge',
  Session: 'per-user session: cascades from users on account deletion',
  Account: 'per-user sign-in method: cascades from users on account deletion',
  TwoFactor: 'per-user 2FA secret: cascades from users on account deletion',
  Verification: 'global, short-lived tokens keyed by identifier (expire within hours)',
  AuditLog: 'audit trail: append-only, ids only, deleted by 730-day retention (§2.6)',
  EmailSuppression: 'global deliverability list: SHA-256 of the address, no organisation',
};

/**
 * Kept models whose personal fields the hard delete clears (NOT_PURGED_MODELS keeps the row).
 * A takedown request keeps source, category, dates, outcome and the staff notes the transparency
 * report and a legal follow-up need; the requester's identity and the pointer to the (now
 * deleted) publication go.
 */
export interface AnonymiseStep {
  table: string;
  model: string;
  /** SET clause clearing the personal fields. */
  set: Sql;
  /** Rows of the organisation that still hold personal data (so a re-run updates nothing). */
  where: (organisationId: string) => Sql;
}

export const ANONYMISE_STEPS: readonly AnonymiseStep[] = [
  {
    table: 'takedown_requests',
    model: 'TakedownRequest',
    set: Prisma.sql`"requester" = NULL, "publicationId" = NULL`,
    where: (o) =>
      Prisma.sql`"organisationId" = ${o} AND ("requester" IS NOT NULL OR "publicationId" IS NOT NULL)`,
  },
];

/** Clears the personal fields of one kept model's rows of the organisation; returns the count. */
export async function anonymiseRows(
  db: PrismaClient,
  step: AnonymiseStep,
  organisationId: string,
): Promise<number> {
  return db.$executeRaw(
    Prisma.sql`UPDATE ${t(step.table)} SET ${step.set} WHERE ${step.where(organisationId)}`,
  );
}

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
