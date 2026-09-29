import type { PrismaClient } from '@prisma/client';

// 15.E1 — what one organisation's data export contains. Every query is scoped to the organisation
// (directly, or through the organisation's own project / publication / link ids), and secrets are
// never selected: platform tokens, share-link token hashes, domain-verification tokens, Hive
// callback token hashes and image embeddings are left out by construction (Prisma `omit` /
// explicit selects), then scrubbed again by key name as defence in depth (redactSecrets).
// provider_jobs (raw provider request/response bodies) are not exported; their cost is in
// provider_usage.

// Phase 18 §5.11: `account` (the organisation and its memberships, and the requesting user’s
// own profile, sign-in methods, 2FA status and session metadata — never secrets or other
// members’ contact details) and `billing` (customer, subscriptions, entitlements, top-up credits;
// invoice PDFs stay in Stripe’s portal).
export const EXPORT_GROUPS = [
  'projects',
  'analytics',
  'brand',
  'image_library',
  'account',
  'billing',
] as const;
export type ExportGroup = (typeof EXPORT_GROUPS)[number];

/** Rows per table; a table with more is cut and listed in the manifest's `truncated`. */
export const MAX_ROWS_PER_TABLE = 50_000;

export type Rows = Array<Record<string, unknown>>;

export interface CollectedTables {
  tables: Record<string, Rows>;
  truncated: string[];
}

const SECRET_KEY = /token|secret|password|embedding/i;

/** Remove any key that looks like a secret, at any depth (defence in depth). */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SECRET_KEY.test(k))
        .map(([k, v]) => [k, redactSecrets(v)]),
    );
  }
  return value;
}

type Db = PrismaClient;
const take = MAX_ROWS_PER_TABLE + 1;

class Collector {
  readonly tables: Record<string, Rows> = {};
  readonly truncated: string[] = [];

  add(name: string, rows: object[]) {
    if (rows.length > MAX_ROWS_PER_TABLE) this.truncated.push(name);
    this.tables[name] = rows.slice(0, MAX_ROWS_PER_TABLE) as Rows;
  }
}

async function collectProjects(db: Db, org: string, c: Collector, projectIds: string[]) {
  const scope = { projectId: { in: projectIds } };
  const scripts = await db.videoScript.findMany({ where: scope, take });
  const scriptIds = scripts.map((s) => s.id);
  const shots = await db.videoShot.findMany({ where: { scriptId: { in: scriptIds } }, take });
  const renders = await db.videoRender.findMany({ where: scope, take });
  const slides = await db.slideshowSlide.findMany({ where: scope, take });
  c.add('video_briefs', await db.videoBrief.findMany({ where: scope, take }));
  c.add('video_scripts', scripts);
  c.add('video_shots', shots);
  c.add('video_renders', renders);
  c.add('slideshow_slides', slides);
  c.add(
    'text_overlays',
    await db.textOverlay.findMany({
      where: {
        OR: [
          { shotId: { in: shots.map((s) => s.id) } },
          { renderId: { in: renders.map((r) => r.id) } },
          { slideId: { in: slides.map((s) => s.id) } },
        ],
      },
      take,
    }),
  );
  c.add(
    'video_assets',
    await db.videoAsset.findMany({ where: { organisationId: org, ...scope }, take }),
  );
  c.add(
    'video_publications',
    await db.videoPublication.findMany({ where: { organisationId: org }, take }),
  );
  c.add('approval_tasks', await db.approvalTask.findMany({ where: scope, take }));
  c.add('safety_reviews', await db.safetyReview.findMany({ where: { organisationId: org }, take }));
  c.add('video_uploads', await db.videoUpload.findMany({ where: { organisationId: org }, take }));
  c.add(
    'share_links',
    await db.shareLink.findMany({
      where: { organisationId: org },
      omit: { tokenHash: true },
      include: { comments: true },
      take,
    }),
  );
}

async function collectAnalytics(db: Db, org: string, c: Collector) {
  const pubIds = (
    await db.videoPublication.findMany({ where: { organisationId: org }, select: { id: true } })
  ).map((p) => p.id);
  c.add(
    'video_analytics',
    await db.videoAnalytic.findMany({ where: { publicationId: { in: pubIds } }, take }),
  );
  c.add(
    'provider_usage',
    await db.providerUsage.findMany({ where: { organisationId: org }, take }),
  );
  c.add('cost_alerts', await db.costAlert.findMany({ where: { organisationId: org }, take }));
  c.add(
    'publication_conversations',
    await db.publicationConversation.findMany({ where: { organisationId: org }, take }),
  );
}

async function collectBrand(db: Db, org: string, c: Collector) {
  const scope = { organisationId: org };
  c.add('brand_kits', await db.brandKit.findMany({ where: scope, take }));
  c.add(
    'voice_profiles',
    await db.voiceProfile.findMany({
      where: scope,
      omit: { consentS3Bucket: true, consentS3Key: true },
      take,
    }),
  );
  c.add(
    'style_memories',
    await db.styleMemory.findMany({ where: { ...scope, deletedAt: null }, take }),
  );
  c.add('business_profiles', await db.businessProfile.findMany({ where: scope, take }));
  c.add('website_scans', await db.websiteScan.findMany({ where: scope, take }));
  c.add(
    'domain_verifications',
    await db.domainVerification.findMany({ where: scope, omit: { token: true }, take }),
  );
  c.add('templates', await db.template.findMany({ where: scope, take }));
  c.add('slideshow_templates', await db.slideshowTemplate.findMany({ where: scope, take }));
  c.add('overlay_presets', await db.overlayPreset.findMany({ where: scope, take }));
}

/** Always exported: the account-level records (connections WITHOUT tokens). */
async function collectAccount(db: Db, org: string, c: Collector) {
  const scope = { organisationId: org };
  c.add(
    'platform_connections',
    await db.platformConnection.findMany({
      where: scope,
      omit: { encryptedAccessToken: true, encryptedRefreshToken: true },
      take,
    }),
  );
  c.add('notifications', await db.notification.findMany({ where: scope, take }));
  c.add(
    'notification_preferences',
    await db.notificationPreference.findMany({ where: scope, take }),
  );
  c.add('onboarding_states', await db.onboardingState.findMany({ where: scope, take }));
}

async function collectIdentity(db: Db, org: string, userId: string | undefined, c: Collector) {
  c.add(
    'organisation',
    await db.organization.findMany({
      where: { id: org },
      select: {
        id: true,
        name: true,
        slug: true,
        country: true,
        defaultLocale: true,
        createdAt: true,
      },
    }),
  );
  c.add(
    'members',
    await db.member.findMany({
      where: { organizationId: org },
      select: { id: true, userId: true, role: true, createdAt: true },
      take,
    }),
  );
  c.add(
    'invitations',
    await db.invitation.findMany({
      where: { organizationId: org },
      select: { id: true, role: true, status: true, expiresAt: true, createdAt: true },
      take,
    }),
  );
  if (!userId) return;
  c.add(
    'my_profile',
    await db.user.findMany({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        locale: true,
        twoFactorEnabled: true,
        role: true,
        createdAt: true,
      },
    }),
  );
  c.add(
    'my_sign_in_methods',
    await db.account.findMany({
      where: { userId },
      select: { providerId: true, createdAt: true },
    }),
  );
  c.add(
    'my_sessions',
    await db.session.findMany({
      where: { userId },
      select: {
        createdAt: true,
        updatedAt: true,
        expiresAt: true,
        ipAddress: true,
        userAgent: true,
      },
      take,
    }),
  );
}

async function collectBilling(db: Db, org: string, c: Collector) {
  const scope = { organisationId: org };
  c.add(
    'billing_customer',
    await db.billingCustomer.findMany({
      where: scope,
      select: { organisationId: true, stripeCustomerId: true, createdAt: true },
    }),
  );
  c.add('subscriptions', await db.subscription.findMany({ where: scope, take }));
  c.add('entitlements', await db.orgEntitlement.findMany({ where: scope }));
  c.add('usage_credits', await db.usageCredit.findMany({ where: scope, take }));
}

export async function collectExport(
  db: Db,
  organisationId: string,
  include: ExportGroup[],
  options: { requestedByUserId?: string } = {},
): Promise<CollectedTables & { projectIds: string[] }> {
  const c = new Collector();
  const projects = await db.videoProject.findMany({
    where: { organisationId, deletedAt: null },
    take,
  });
  const projectIds = projects.map((p) => p.id);
  await collectAccount(db, organisationId, c);
  if (include.includes('projects')) {
    c.add('video_projects', projects);
    await collectProjects(db, organisationId, c, projectIds);
  }
  if (include.includes('analytics')) await collectAnalytics(db, organisationId, c);
  if (include.includes('brand')) await collectBrand(db, organisationId, c);
  if (include.includes('image_library'))
    c.add('image_library', await db.imageLibraryItem.findMany({ where: { organisationId }, take }));
  if (include.includes('account'))
    await collectIdentity(db, organisationId, options.requestedByUserId, c);
  if (include.includes('billing')) await collectBilling(db, organisationId, c);
  return { tables: c.tables, truncated: c.truncated, projectIds };
}
