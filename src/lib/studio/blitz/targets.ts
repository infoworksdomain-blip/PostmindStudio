import type { PrismaClient } from '@prisma/client';
import type { AutoPublishTarget } from '../automation/targets';
import { channelPlanForOrganisation, loadChannelUsage } from '../billing/channels';
import { PLATFORM_RULES } from '../platforms/rules';
import type { Platform } from '../services/catalog';
import { FORMATS, type FormatKey } from './formats';

// 22.4 / 22.5 — where a kept card (or an automation slot) is posted: one connected account per
// network, the destination that suits the format (feed for carousels, Reels / Shorts for videos),
// inside the plan's channel limit (21.5: the first-connected N networks publish).
//
// TikTok carousels are photo posts that pull the slide JPEGs from a URL on a domain verified for
// the app (21.6, Photo Post docs read 2026-10-04: `url_ownership_unverified` otherwise). Until the
// operator says the slide domain is verified (STUDIO_TIKTOK_PHOTO_DOMAIN_VERIFIED=1), a TikTok
// carousel target is left out and reported "download only" instead of failing silently.

/** Destinations in preference order: the first one per network that takes the format wins. */
const CAROUSEL_ORDER: readonly Platform[] = [
  'instagram_feed',
  'facebook_feed',
  'linkedin_video',
  'tiktok',
];
const VIDEO_ORDER: readonly Platform[] = [
  'tiktok',
  'instagram_reel',
  'youtube_short',
  'facebook',
  'linkedin_video',
  'x',
];

type Env = Record<string, string | undefined>;

export function tiktokPhotoPostsVerified(env: Env = process.env): boolean {
  const raw = env.STUDIO_TIKTOK_PHOTO_DOMAIN_VERIFIED?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** The destination per connection network for `format` (null = the network does not take it). */
export function destinationFor(format: FormatKey, network: string): Platform | null {
  const order = format === 'carousel' ? CAROUSEL_ORDER : VIDEO_ORDER;
  return (
    order.find(
      (p) => PLATFORM_RULES[p].connectionPlatform === network && FORMATS[format].platforms(p),
    ) ?? null
  );
}

export interface AccountTargets {
  targets: AutoPublishTarget[];
  /** Networks connected but not posted to automatically (TikTok photo posts unverified). */
  downloadOnly: Platform[];
  /** Networks connected past the plan's channel limit. */
  overChannelLimit: string[];
}

type Db = Pick<PrismaClient, 'platformConnection' | 'orgEntitlement'>;

/**
 * The targets for `format` in this business. `only` limits them to some destinations (an
 * automation's chosen platforms).
 */
export async function accountTargets(
  db: Db,
  scope: { organisationId: string; businessId: string },
  format: FormatKey,
  options: { now: number; env?: Env; only?: readonly string[] },
): Promise<AccountTargets> {
  const connections = await db.platformConnection.findMany({
    where: {
      organisationId: scope.organisationId,
      state: 'active',
      OR: [{ businessId: scope.businessId }, { businessId: null }],
    },
    orderBy: { connectedAt: 'asc' },
    select: { id: true, platform: true, businessId: true },
  });
  const plan = await channelPlanForOrganisation(db, scope.organisationId, new Date(options.now));
  const allowed = plan
    ? new Set((await loadChannelUsage(db, scope.organisationId, plan.channels)).allowed)
    : null;
  const out: AccountTargets = { targets: [], downloadOnly: [], overChannelLimit: [] };
  const seen = new Set<string>();
  // The business's own account first, then an organisation-wide one.
  const ordered = [...connections].sort(
    (a, b) => Number(b.businessId !== null) - Number(a.businessId !== null),
  );
  for (const c of ordered) {
    if (seen.has(c.platform)) continue;
    seen.add(c.platform);
    const destination = destinationFor(format, c.platform);
    if (!destination) continue;
    if (options.only && !options.only.includes(destination)) continue;
    if (allowed && !allowed.has(c.platform)) {
      out.overChannelLimit.push(c.platform);
      continue;
    }
    if (
      format === 'carousel' &&
      destination === 'tiktok' &&
      !tiktokPhotoPostsVerified(options.env)
    ) {
      out.downloadOnly.push(destination);
      continue;
    }
    out.targets.push({ platform: destination, connectionId: c.id });
  }
  return out;
}

/** Destinations a pre-made card renders for before anyone chose: connected, else a default. */
export function renderPlatforms(format: FormatKey, connected: readonly Platform[]): Platform[] {
  const fitting = connected.filter((p) => FORMATS[format].platforms(p));
  if (fitting.length) return fitting;
  return format === 'carousel' ? ['instagram_feed'] : ['tiktok', 'instagram_reel'];
}
