import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ChannelLimitError } from '../../errors';
import { assertChannelAllowed, channelUsage, type ConnectionFact } from './channels';

// 21.5 — only the channels an organisation pays for publish: the platforms connected first.

const at = (iso: string) => new Date(iso);
const conn = (platform: string, iso: string, state = 'active'): ConnectionFact => ({
  platform,
  connectedAt: at(iso),
  state,
});

describe('channelUsage (pure)', () => {
  const connections = [
    conn('youtube', '2026-10-03T00:00:00Z'),
    conn('tiktok', '2026-10-01T00:00:00Z'),
    conn('instagram', '2026-10-02T00:00:00Z'),
    // A second TikTok account later does not take another channel.
    conn('tiktok', '2026-10-05T00:00:00Z'),
    conn('linkedin', '2026-10-04T00:00:00Z'),
    conn('x', '2026-09-01T00:00:00Z', 'revoked'),
  ];

  it('the platforms connected first fill the paid channels; the rest are blocked', () => {
    expect(channelUsage(connections, 2)).toEqual({
      paid: 2,
      connected: ['tiktok', 'instagram', 'youtube', 'linkedin'],
      allowed: ['tiktok', 'instagram'],
      blocked: ['youtube', 'linkedin'],
    });
  });

  it('revoked connections never count; enough channels block nothing', () => {
    expect(channelUsage(connections, 6).blocked).toEqual([]);
    expect(channelUsage([conn('x', '2026-09-01T00:00:00Z', 'revoked')], 1).connected).toEqual([]);
  });

  it('a platform needing reconnection keeps its slot (it is still connected)', () => {
    const usage = channelUsage(
      [
        conn('tiktok', '2026-10-01T00:00:00Z', 'needs_reconnect'),
        conn('x', '2026-10-02T00:00:00Z'),
      ],
      1,
    );
    expect(usage.allowed).toEqual(['tiktok']);
    expect(usage.blocked).toEqual(['x']);
  });

  it('ties are broken by platform name (deterministic)', () => {
    const same = '2026-10-01T00:00:00Z';
    expect(channelUsage([conn('x', same), conn('facebook', same)], 1).allowed).toEqual([
      'facebook',
    ]);
  });
});

function db(overrides: unknown, connections: ConnectionFact[]) {
  return {
    orgEntitlement: {
      findUnique: async () =>
        overrides === null
          ? null
          : {
              organisationId: 'org-1',
              tier: 'STANDARD',
              access: 'full',
              source: 'stripe',
              graceUntil: null,
              overrides,
              everPaidAt: null,
            },
    },
    platformConnection: { findMany: async () => connections },
  } as unknown as Pick<PrismaClient, 'orgEntitlement' | 'platformConnection'>;
}

describe('assertChannelAllowed (createPublication)', () => {
  const derived = {
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    status: 'active',
    channels: 1,
    interval: 'month',
  };
  const connections = [
    conn('tiktok', '2026-10-01T00:00:00Z'),
    conn('youtube', '2026-10-02T00:00:00Z'),
  ];
  const now = at('2026-10-10T00:00:00Z');

  it('lets a platform inside the paid channels publish', async () => {
    await expect(
      assertChannelAllowed(db({ derived }, connections), 'org-1', 'tiktok', now),
    ).resolves.toBeUndefined();
  });

  it('a platform past the limit answers channel_limit with an upgrade prompt', async () => {
    const err = await assertChannelAllowed(
      db({ derived }, connections),
      'org-1',
      'youtube',
      now,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelLimitError);
    expect(err).toMatchObject({
      status: 403,
      code: 'channel_limit',
      details: { channels: 1, platform: 'youtube', allowedPlatforms: ['tiktok'] },
    });
    expect((err as Error).message).toMatch(/Add a channel to publish to youtube/);
  });

  it('no channel plan (no row, legacy tier, ENTERPRISE): no limit', async () => {
    await expect(
      assertChannelAllowed(db(null, connections), 'org-1', 'youtube', now),
    ).resolves.toBeUndefined();
    const legacy = { derived: { ...derived, channels: undefined, interval: undefined } };
    await expect(
      assertChannelAllowed(db(legacy, connections), 'org-1', 'youtube', now),
    ).resolves.toBeUndefined();
  });

  it('a staff override of the channels lifts the limit', async () => {
    const admin = {
      channels: 2,
      reason: 'goodwill',
      setByUserId: 's',
      setAt: now.toISOString(),
      expiresAt: null,
    };
    await expect(
      assertChannelAllowed(db({ derived, admin }, connections), 'org-1', 'youtube', now),
    ).resolves.toBeUndefined();
  });
});
