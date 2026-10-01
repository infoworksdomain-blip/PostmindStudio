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
  /** English (the fallback for a code this build does not know). */
  reason?: string;
  /** 17.9: parameters for review.automation.reasons.<code>. */
  params?: Record<string, string | number>;
  humanApprovedCount?: number;
  threshold?: number;
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

/** 20.3: why an approved SCHEDULED project got no drip slot (automation/outbox.ts). */
export interface ScheduleIssue {
  reason: 'queue_off' | 'no_matching_platform' | 'no_free_slot';
  horizonDays: number;
  at: string;
}

const SCHEDULE_ISSUE_REASONS: ReadonlyArray<ScheduleIssue['reason']> = [
  'queue_off',
  'no_matching_platform',
  'no_free_slot',
];

export function readScheduleIssue(metadata: Record<string, unknown> | null): ScheduleIssue | null {
  const issue = record(metadata?.scheduleIssue);
  if (!issue || !SCHEDULE_ISSUE_REASONS.includes(issue.reason as ScheduleIssue['reason']))
    return null;
  return {
    reason: issue.reason as ScheduleIssue['reason'],
    horizonDays: typeof issue.horizonDays === 'number' ? issue.horizonDays : 56,
    at: typeof issue.at === 'string' ? issue.at : '',
  };
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

/** 20.12: this business has at least one active connected account (any platform). */
export function hasConnectedAccount(
  connections: PlatformConnection[] | undefined,
  businessId: string | null,
): boolean {
  return (connections ?? []).some((c) => c.state === 'active' && belongsToBusiness(c, businessId));
}

/**
 * 20.12: the render platforms among `platforms` that an active account of this business can post
 * to ("platforms" are formats to render; "accounts" are where they are posted).
 */
export function publishablePlatforms(
  platforms: readonly string[],
  connections: PlatformConnection[] | undefined,
  businessId: string | null,
): string[] {
  return platforms.filter((p) => connectionsFor(p, connections, businessId).length > 0);
}

/**
 * 20.12: the account each platform posts to. The owner's choice wins while it is still one of
 * this business's active accounts ('' = "don't post there"); otherwise the platform's only
 * account is pre-selected. A choice made for another business (or a disconnected account) is
 * dropped, so switching business never posts to the wrong account.
 */
export function resolveAccounts(
  platforms: readonly string[],
  chosen: Record<string, string>,
  connections: PlatformConnection[] | undefined,
  businessId: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const platform of platforms) {
    const options = connectionsFor(platform, connections, businessId);
    const pick = chosen[platform];
    if (pick === '') continue;
    if (pick && options.some((c) => c.id === pick)) out[platform] = pick;
    else if (options.length === 1 && options[0]) out[platform] = options[0].id;
  }
  return out;
}
