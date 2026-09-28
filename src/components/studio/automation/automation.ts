import type { PlatformConnection } from '@/lib/client/types';
import { belongsToBusiness } from '../connections/platforms';

// Client view of review/publish automation (services/templates.ts, automation/*.ts). Pure helpers
// so the Create and Review screens' rules are unit-tested without rendering.

export interface AutoPublishTarget {
  platform: string;
  connectionId?: string;
  platformAccountId?: string;
  caption?: string;
  hashtags?: string[];
  scheduleOffsetMinutes?: number;
}

export interface PublishDefaults {
  publishPolicy: 'MANUAL' | 'SCHEDULED' | 'AUTO_ON_APPROVAL';
  reviewPolicy?: 'AUTO_APPROVE' | 'REQUIRE_APPROVAL' | 'REQUIRE_APPROVAL_FROM_ROLE';
  targets: AutoPublishTarget[];
}

/** GET /api/studio/templates item. */
export interface ProjectTemplate {
  id: string;
  organisationId: string | null;
  builtIn: boolean;
  name: string;
  category: string;
  targetFormats: Array<{ platform: string; aspectRatio: string; duration: number }>;
  shotBlueprint: { shots?: unknown[] } | null;
  publishDefaults: PublishDefaults | null;
  createdAt: string;
}

export interface ReviewRecord {
  decision: 'auto_approved' | 'needs_review';
  code?: string;
  reason?: string;
  at: string;
}

export interface AutoPublishTargetResult {
  index: number;
  platform: string;
  account: string | null;
  status: 'created' | 'failed';
  publicationId?: string;
  scheduledFor?: string | null;
  error?: string;
}

export interface AutoPublishResult {
  at: string;
  trigger: 'human' | 'auto';
  status: 'created' | 'partial' | 'failed' | 'no_targets';
  results: AutoPublishTargetResult[];
  error?: string;
}

/** Render platforms → the connection platform they publish through (IG/FB: Core-registered). */
export const AUTO_PUBLISH_CONNECTION: Record<string, string> = {
  tiktok: 'tiktok',
  youtube_short: 'youtube',
  youtube: 'youtube',
  linkedin_video: 'linkedin',
  x: 'x',
  instagram_reel: 'instagram',
  facebook: 'facebook',
  instagram_feed: 'instagram',
  facebook_feed: 'facebook',
};

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function readReview(metadata: Record<string, unknown> | null): ReviewRecord | null {
  const review = record(metadata?.review);
  return review && (review.decision === 'auto_approved' || review.decision === 'needs_review')
    ? (review as unknown as ReviewRecord)
    : null;
}

export function readTargets(metadata: Record<string, unknown> | null): AutoPublishTarget[] {
  const targets = record(metadata?.autoPublish)?.targets;
  return Array.isArray(targets)
    ? targets.filter((t): t is AutoPublishTarget => typeof record(t)?.platform === 'string')
    : [];
}

export function readAutoPublishResult(
  metadata: Record<string, unknown> | null,
): AutoPublishResult | null {
  const result = record(metadata?.autoPublishResult);
  return result && Array.isArray(result.results) ? (result as unknown as AutoPublishResult) : null;
}

/** Who approved: the newest APPROVED approval row (system actors start with "system:"). */
export function approvalOrigin(
  approvals: Array<{ state: string; resolvedByUserId?: string | null }>,
): 'automatic' | 'person' | null {
  const approved = approvals.find((a) => a.state === 'APPROVED');
  if (!approved) return null;
  return approved.resolvedByUserId?.startsWith('system:') ? 'automatic' : 'person';
}

/** Active connections of this business that can publish a render platform. */
export function connectionsFor(
  platform: string,
  connections: PlatformConnection[] | undefined,
  businessId: string | null,
): PlatformConnection[] {
  const needed = AUTO_PUBLISH_CONNECTION[platform];
  if (!needed) return [];
  return (connections ?? []).filter(
    (c) => c.platform === needed && c.state === 'active' && belongsToBusiness(c, businessId),
  );
}

/** { platform → connectionId } chosen in the Create screen → API targets (unset ones dropped). */
export function buildTargets(
  platforms: string[],
  accounts: Record<string, string>,
): AutoPublishTarget[] {
  return platforms.flatMap((platform) =>
    AUTO_PUBLISH_CONNECTION[platform] && accounts[platform]
      ? [{ platform, connectionId: accounts[platform] }]
      : [],
  );
}

export function templatePlatforms(template: ProjectTemplate | undefined): string[] {
  return (template?.targetFormats ?? []).map((f) => f.platform);
}
