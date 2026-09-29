import type { PrismaClient } from '@prisma/client';
import { ConflictError } from '../../errors';
import type { StudioModes } from '../../mode';
import type { CoreSyncClients } from '../pipeline/deps';
import { metaConnectConfigured, metaOAuthFromEnv } from '../platforms/meta-oauth';
import type { MetaConnectDeps } from '../services/meta-connect';
import { assertBusinessInOrg } from '../services/businesses';
import { pendingCoreBusinessDirectory, type BusinessDirectory } from './business-directory';
import { createLocalBusinessDirectory } from './local-business-directory';
import { createLocalOrganisationDirectory } from './local-organisation-directory';

// Phase 18 §2.12 — the ONE place the PostMind Core / Engagement adapters are chosen by mode
// (mode.ts). Callers (api/context.ts, pipeline/create-deps.ts, the Core-sync worker, the routes
// that list businesses) ask this module instead of checking STUDIO_MODE themselves.
//
// Standalone mode never calls a POSTMIND_* or ENGAGEMENT_* URL: every adapter chosen here is
// local, off, or the "pending" client that is never invoked (select.test.ts spies on fetch).

type Env = Record<string, string | undefined>;

/** Validates businessId on writes (route wrapper). */
export type BusinessGuard = (organisationId: string, businessId: string) => Promise<void>;

/** The business list: studio.businesses (local) or Core's directory (pending until Core ships). */
export function selectBusinessDirectory(
  modes: Pick<StudioModes, 'businesses'>,
  db: Pick<PrismaClient, 'business'>,
  core?: BusinessDirectory,
): BusinessDirectory {
  if (core) return core;
  return modes.businesses === 'local'
    ? createLocalBusinessDirectory(db)
    : pendingCoreBusinessDirectory;
}

/**
 * Local mode checks every businessId a write names against studio.businesses. Core mode has no
 * way to verify Core's ids (the pre-Phase-18 behaviour), so there is no guard.
 */
export function selectBusinessGuard(
  modes: Pick<StudioModes, 'businesses'>,
  db: Pick<PrismaClient, 'business'>,
): BusinessGuard | undefined {
  if (modes.businesses !== 'local') return undefined;
  return (organisationId, businessId) => assertBusinessInOrg(db, organisationId, businessId);
}

/** Business CRUD (POST / PATCH / DELETE /businesses) exists only when Studio owns the list. */
export function businessesAreLocal(modes: Pick<StudioModes, 'businesses'>): boolean {
  return modes.businesses === 'local';
}

/** Businesses are PostMind Core's in core mode: Studio cannot create, rename or delete them. */
export function assertLocalBusinesses(modes: Pick<StudioModes, 'businesses'>): void {
  if (!businessesAreLocal(modes))
    throw new ConflictError('Businesses are managed in PostMind (STUDIO_BUSINESSES=core)');
}

/**
 * The scheduled Core-sync jobs (queue/workers/core-sync.ts):
 * - organisations: standalone identity owns studio.organisations, so reconciliation is local;
 * - usage: Stripe billing keeps usage rows as the local record (state `local`, never sent);
 * - calendar: Studio's /calendar is the calendar outside core mode, so no shadow rows;
 * - channels: with Studio's own Meta login Studio is the source of truth (nothing to reconcile).
 * Core mode keeps the pending clients (nothing is sent until Core ships its APIs).
 */
export function selectCoreSyncClients(
  modes: Pick<StudioModes, 'mode' | 'identity' | 'billing' | 'metaConnect'>,
  db: Pick<PrismaClient, 'organization'>,
): CoreSyncClients {
  return {
    ...(modes.identity === 'standalone' && {
      organisations: createLocalOrganisationDirectory(db),
    }),
    usageRecording: modes.billing === 'stripe' ? 'local' : 'outbox',
    calendarShadows: modes.mode === 'core',
    channelReconciliation: channelReconciliationApplies(modes),
  };
}

export const CHANNEL_RECONCILIATION_NOT_APPLICABLE =
  'Not applicable in standalone mode: Studio runs the Meta login and is the source of truth for Instagram and Facebook channels (STUDIO_META_CONNECT=studio)';

/** Core ↔ Studio Meta channel reconciliation only exists while Core pushes the channels. */
export function channelReconciliationApplies(modes: Pick<StudioModes, 'metaConnect'>): boolean {
  return modes.metaConnect === 'core';
}

/**
 * Meta (Facebook / Instagram) connect: Studio's own Facebook Login for Business when
 * STUDIO_META_CONNECT=studio and the operator has set the app (META_APP_ID, META_APP_SECRET,
 * META_LOGIN_CONFIG_ID); otherwise Connect answers 409 (core) / 501 (not configured).
 */
export function selectMetaConnect(
  modes: Pick<StudioModes, 'metaConnect'>,
  env: Env = process.env,
): MetaConnectDeps {
  return {
    modes,
    configured: modes.metaConnect === 'studio' && metaConnectConfigured(env),
    client: () => metaOAuthFromEnv(env),
  };
}

/**
 * Engagement (attribution, trigger fields, sentiment) is optional and off unless
 * ENGAGEMENT_INTERNAL_URL is set (§0). It needs the shared service token too.
 */
export function engagementEnabled(env: Env = process.env): boolean {
  return Boolean(env.ENGAGEMENT_INTERNAL_URL?.trim() && env.POSTMIND_SERVICE_TOKEN?.trim());
}

/** "Make a video from this post" (POSTMIND_CONTENT) reads Core's content: core mode only. */
export function coreContentAvailable(modes: Pick<StudioModes, 'mode'>): boolean {
  return modes.mode === 'core';
}
