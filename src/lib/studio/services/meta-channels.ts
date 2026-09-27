import type { PlatformConnection, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '../../errors';
import type { DataKeyProvider } from '../crypto/envelope';
import { META_CHANNEL_PLATFORMS } from '../platforms/meta-credentials';
import { sealTokens } from '../platforms/tokens';

// Meta channels registered by PostMind Core (operator decision 2026-09-27: mirror Engagement).
// Engagement handover 9.5: PostMind runs the Meta login, exchanges the code for a long-lived user
// token, fetches the pages/IG accounts and their tokens, then POSTs
// { organisationId, platform, platformAccountId, accessToken, ... } to the service's internal
// channels endpoint; 9.6: tokens are stored envelope-encrypted (AES-256-GCM, KMS data key) and
// PostMind's nightly job refreshes them (14.13 POST /internal/tokens/refreshed). Studio stores
// them in platform_connections with the same sealing as its own OAuth tokens (tokens.ts).

export const CORE_ACTOR = 'system:postmind-core';
export const MAX_REFRESH_BATCH = 100;

/** Graph object ids (IG user id, Page id) are numeric strings. */
const graphId = z
  .string()
  .trim()
  .regex(/^\d{1,64}$/, 'must be a numeric Graph id');
const organisationId = z.string().trim().min(1).max(128);
const platform = z.enum(META_CHANNEL_PLATFORMS);
// Meta tokens are opaque; bound them and refuse whitespace (a pasted header, not a token).
const accessToken = z.string().min(16).max(4_096).regex(/^\S+$/, 'must not contain whitespace');
const expiresAt = z.iso.datetime({ offset: true }).nullable().optional();
const scopes = z.array(z.string().trim().min(1).max(100)).max(50);

export const registerMetaChannelInput = z.object({
  organisationId,
  platform,
  platformAccountId: graphId,
  platformAccountName: z.string().trim().min(1).max(200),
  accessToken,
  /** Page tokens from a long-lived user token do not expire: null / omitted. */
  tokenExpiresAt: expiresAt,
  scopes: scopes.default([]),
  /** Studio/Core business the account belongs to; omitted = every business in the org. */
  businessId: z.string().trim().min(1).max(128).optional(),
  /** The PostMind user who connected the account (for the audit trail). */
  connectedByUserId: z.string().trim().min(1).max(128).optional(),
});

export const refreshedTokenInput = z.object({
  organisationId,
  platform,
  platformAccountId: graphId,
  accessToken,
  tokenExpiresAt: expiresAt,
  scopes: scopes.optional(),
});

/** One token, or the nightly job's batch. */
export const refreshedTokensInput = z.union([
  z.object({ channels: z.array(refreshedTokenInput).min(1).max(MAX_REFRESH_BATCH) }),
  refreshedTokenInput,
]);

export const accountRefInput = z.object({ organisationId, platform, platformAccountId: graphId });

export type RegisterMetaChannelInput = z.infer<typeof registerMetaChannelInput>;
export type RefreshedTokenInput = z.infer<typeof refreshedTokenInput>;
export type AccountRef = z.infer<typeof accountRefInput>;

export interface MetaChannelDeps {
  db: Pick<PrismaClient, 'platformConnection'>;
  keys: DataKeyProvider;
}

/** Response shape: never the token or its ciphertext. */
export function publicChannel(c: PlatformConnection) {
  return {
    id: c.id,
    organisationId: c.organisationId,
    businessId: c.businessId,
    platform: c.platform,
    platformAccountId: c.platformAccountId,
    platformAccountName: c.platformAccountName,
    accessTokenExpiresAt: c.accessTokenExpiresAt,
    scopes: c.scopes,
    state: c.state,
    connectedAt: c.connectedAt,
  };
}

const uniqueKey = (ref: AccountRef) => ({
  organisationId_platform_platformAccountId: {
    organisationId: ref.organisationId,
    platform: ref.platform,
    platformAccountId: ref.platformAccountId,
  },
});

function seal(keys: DataKeyProvider, input: RefreshedTokenInput | RegisterMetaChannelInput) {
  // Meta page/IG tokens have no refresh token: Core refreshes and pushes new ones.
  return sealTokens(keys, input.organisationId, input.platform, {
    accessToken: input.accessToken,
    expiresAt: input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : undefined,
    scopes: input.scopes ?? [],
  });
}

/** Idempotent upsert: re-registering (a reconnect) replaces the token and re-activates. */
export async function registerMetaChannel(
  deps: MetaChannelDeps,
  input: RegisterMetaChannelInput,
): Promise<{ channel: PlatformConnection; created: boolean }> {
  const where = uniqueKey(input);
  const existing = await deps.db.platformConnection.findUnique({
    where,
    select: { id: true },
  });
  const sealed = await seal(deps.keys, input);
  const data = {
    platformAccountName: input.platformAccountName,
    ...sealed,
    scopes: input.scopes,
    state: 'active',
    connectedByUserId: input.connectedByUserId ?? CORE_ACTOR,
    connectedAt: new Date(),
  };
  const channel = await deps.db.platformConnection.upsert({
    where,
    create: {
      organisationId: input.organisationId,
      platform: input.platform,
      platformAccountId: input.platformAccountId,
      businessId: input.businessId ?? null,
      ...data,
    },
    // A re-registration without a businessId keeps the one already recorded.
    update: { ...data, ...(input.businessId && { businessId: input.businessId }) },
  });
  return { channel, created: !existing };
}

/** Wipes the token (not just flags it), as a user disconnect does (services/connections.ts). */
const REVOKED = {
  state: 'revoked',
  encryptedAccessToken: '',
  encryptedRefreshToken: null,
  accessTokenExpiresAt: null,
} as const;

/**
 * Disconnect by Studio channel id (the id POST /internal/channels returned). Only Meta channels:
 * Core cannot touch Studio's own OAuth connections. Idempotent: an already revoked channel is fine.
 */
export async function disconnectMetaChannelById(
  db: MetaChannelDeps['db'],
  id: string,
  organisationId?: string,
): Promise<PlatformConnection> {
  const where = {
    id,
    platform: { in: [...META_CHANNEL_PLATFORMS] },
    ...(organisationId && { organisationId }),
  };
  const updated = await db.platformConnection.updateMany({ where, data: REVOKED });
  if (updated.count === 0) throw new NotFoundError('Channel not found');
  return db.platformConnection.findUniqueOrThrow({ where: { id } });
}

export async function disconnectMetaChannelByAccount(
  db: MetaChannelDeps['db'],
  ref: AccountRef,
): Promise<PlatformConnection> {
  const updated = await db.platformConnection.updateMany({ where: { ...ref }, data: REVOKED });
  if (updated.count === 0) throw new NotFoundError('Channel not found');
  return db.platformConnection.findUniqueOrThrow({ where: uniqueKey(ref) });
}

export type RefreshOutcome = 'updated' | 'not_found' | 'revoked';

export interface RefreshResult {
  platform: string;
  platformAccountId: string;
  organisationId: string;
  result: RefreshOutcome;
  id?: string;
}

/**
 * Store a token Core refreshed. A needs_reconnect channel becomes active again (Meta accepted
 * the refresh, so the grant is live). A revoked channel stays revoked: the user disconnected it,
 * and only a new registration (POST /internal/channels) reconnects.
 */
export async function storeRefreshedToken(
  deps: MetaChannelDeps,
  input: RefreshedTokenInput,
): Promise<RefreshResult> {
  const ref = {
    organisationId: input.organisationId,
    platform: input.platform,
    platformAccountId: input.platformAccountId,
  };
  const current = await deps.db.platformConnection.findUnique({
    where: uniqueKey(ref),
    select: { id: true, state: true },
  });
  if (!current) return { ...ref, result: 'not_found' };
  if (current.state === 'revoked') return { ...ref, id: current.id, result: 'revoked' };
  const sealed = await seal(deps.keys, input);
  const updated = await deps.db.platformConnection.updateMany({
    // Guard against a disconnect racing this refresh.
    where: { id: current.id, state: { not: 'revoked' } },
    data: {
      encryptedAccessToken: sealed.encryptedAccessToken,
      accessTokenExpiresAt: sealed.accessTokenExpiresAt,
      state: 'active',
      ...(input.scopes && { scopes: input.scopes }),
    },
  });
  return { ...ref, id: current.id, result: updated.count ? 'updated' : 'revoked' };
}

/** Single-token form: a missing or disconnected channel is an error the caller can act on. */
export function assertRefreshed(result: RefreshResult): void {
  if (result.result === 'not_found')
    throw new NotFoundError('Channel not registered; POST /api/studio/internal/channels first');
  if (result.result === 'revoked')
    throw new ConflictError('Channel was disconnected; register it again to reconnect');
}
