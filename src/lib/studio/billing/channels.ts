import type { PrismaClient } from '@prisma/client';
import { ChannelLimitError } from '../../errors';
import { resolveStoredEntitlements } from './entitlements';
import type { ChannelPlanEntitlement } from './entitlements-reader';

// Phase 21.5 — the channel limit. A channel is a social platform (platform_connections.platform:
// tiktok, instagram, youtube, facebook, linkedin, x). An organisation paying for N channels may
// connect more platforms (connecting is never blocked: they see what they could add), but only
// N of them publish. Which N: the platforms connected first (earliest connection that is not
// revoked), so adding a platform never takes publishing away from one already in use, and
// disconnecting one frees its slot.
//
// Enforced in createPublication (services/publications.ts) — the single funnel every publication
// goes through: POST /publications, auto-publish on approval, schedules, drip queue and month
// plans. A blocked platform answers 403 channel_limit (ChannelLimitError) with the channels and
// the allowed platforms; the app opens the "add a channel" dialog, and an auto-publish target
// records the plain-language reason on the project's Review screen (not retried).
//
// No channel plan (core mode, legacy tiers, ENTERPRISE, no plan) = no channel limit here.

/** The platforms that count as channels (platform_connections.platform). */
export const CHANNEL_PLATFORMS = [
  'tiktok',
  'instagram',
  'youtube',
  'facebook',
  'linkedin',
  'x',
] as const;

export interface ConnectionFact {
  platform: string;
  connectedAt: Date;
  state: string;
}

export interface ChannelUsage {
  /** Channels paid for. */
  paid: number;
  /** Distinct platforms connected (not revoked), oldest first. */
  connected: string[];
  /** The platforms that publish: the first `paid` of `connected`. */
  allowed: string[];
  /** Connected platforms past the limit: they do not publish until a channel is added. */
  blocked: string[];
}

/** Pure: which connected platforms are inside the paid channels. */
export function channelUsage(connections: readonly ConnectionFact[], paid: number): ChannelUsage {
  const first = new Map<string, number>();
  for (const c of connections) {
    if (c.state === 'revoked') continue;
    const at = c.connectedAt.getTime();
    const seen = first.get(c.platform);
    if (seen === undefined || at < seen) first.set(c.platform, at);
  }
  const connected = [...first.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([platform]) => platform);
  return {
    paid,
    connected,
    allowed: connected.slice(0, Math.max(0, paid)),
    blocked: connected.slice(Math.max(0, paid)),
  };
}

type ChannelDb = Pick<PrismaClient, 'orgEntitlement' | 'platformConnection'>;

/** The channel plan in force for an organisation (read from org_entitlements, uncached). */
export async function channelPlanForOrganisation(
  db: Pick<PrismaClient, 'orgEntitlement'>,
  organisationId: string,
  now: Date,
): Promise<ChannelPlanEntitlement | null> {
  const row = await db.orgEntitlement.findUnique({ where: { organisationId } });
  return row ? (resolveStoredEntitlements(row, now).channelPlan ?? null) : null;
}

export async function loadChannelUsage(
  db: Pick<PrismaClient, 'platformConnection'>,
  organisationId: string,
  paid: number,
): Promise<ChannelUsage> {
  const rows = await db.platformConnection.findMany({
    where: { organisationId, state: { not: 'revoked' } },
    select: { platform: true, connectedAt: true, state: true },
  });
  return channelUsage(rows, paid);
}

/**
 * Throws ChannelLimitError when `platform` (a connection platform) is past the organisation's
 * paid channels. Does nothing without a channel plan.
 */
export async function assertChannelAllowed(
  db: ChannelDb,
  organisationId: string,
  platform: string,
  now: Date,
): Promise<void> {
  const plan = await channelPlanForOrganisation(db, organisationId, now);
  if (!plan) return;
  const usage = await loadChannelUsage(db, organisationId, plan.channels);
  if (usage.allowed.includes(platform)) return;
  throw new ChannelLimitError(
    `Your plan includes ${plan.channels} ${plan.channels === 1 ? 'channel' : 'channels'} (${
      usage.allowed.join(', ') || 'none connected yet'
    }). Add a channel to publish to ${platform}.`,
    { channels: plan.channels, platform, allowedPlatforms: usage.allowed },
  );
}
