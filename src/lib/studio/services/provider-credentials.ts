import { Prisma, type PrismaClient, type ProviderCredential } from '@prisma/client';
import { z } from 'zod';
import {
  ConflictError,
  FeatureDisabledError,
  NotFoundError,
  PlanTierError,
  ValidationError,
} from '../../errors';
import type { TenantContext } from '../../tenant';
import { decryptSecret, encryptSecret, type DataKeyProvider } from '../crypto/envelope';
import {
  byocProvider,
  isByocProviderId,
  type ByocProviderId,
  type ProviderKey,
  type ProviderKeyMap,
} from '../providers/byoc-providers';
import type { ProviderAdapter } from '../providers/interface';
import { toPlanTier } from './catalog';
import { findProject } from './projects';

// Phase 15 operator decision P1 (2026-09-28; spec 6.6 / 12.6 "Enterprise customers may provide
// their own provider API keys"). BYOC keys per organisation: stored envelope-encrypted, never
// returned, tested with the adapter's own healthCheck(), revoked by wiping the key material.
//
// Gates (both must pass for any mutation; the list answers { enabled: false, reason } instead):
//   STUDIO_BYOC_ENABLED=true  else 403 feature_disabled (feature "byoc")
//   plan tier ENTERPRISE      else 403 plan_tier (requiredTier "ENTERPRISE")

type Env = Record<string, string | undefined>;
type Db = PrismaClient;

export const BYOC_FEATURE = 'byoc';
export const BYOC_CREDENTIAL_ACTIVE = 'active';
export const BYOC_CREDENTIAL_REVOKED = 'revoked';
const HINT_CHARS = 4;
const MAX_REASON_CHARS = 300;

export type ByocUnavailableReason = 'disabled' | 'plan_tier';
export type ByocAvailability =
  { enabled: true } | { enabled: false; reason: ByocUnavailableReason };

export function byocEnabled(env: Env = process.env): boolean {
  return env.STUDIO_BYOC_ENABLED?.trim().toLowerCase() === 'true';
}

export function byocAvailability(
  tenant: Pick<TenantContext, 'organisation'>,
  env: Env = process.env,
): ByocAvailability {
  if (!byocEnabled(env)) return { enabled: false, reason: 'disabled' };
  if (toPlanTier(tenant.organisation.planTier) !== 'ENTERPRISE')
    return { enabled: false, reason: 'plan_tier' };
  return { enabled: true };
}

export function assertByocAvailable(
  tenant: Pick<TenantContext, 'organisation'>,
  env: Env = process.env,
): void {
  const availability = byocAvailability(tenant, env);
  if (availability.enabled) return;
  if (availability.reason === 'disabled')
    throw new FeatureDisabledError(BYOC_FEATURE, 'Bring-your-own provider keys are not enabled');
  throw new PlanTierError('ENTERPRISE', 'Bring-your-own provider keys need the Enterprise plan', {
    planTier: tenant.organisation.planTier ?? null,
  });
}

// ---- in-process change notifications (the registry cache listens) ----

type ChangeListener = (organisationId: string) => void;
const listeners = new Set<ChangeListener>();

export function onByocKeysChanged(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyChanged(organisationId: string): void {
  for (const listener of listeners) listener(organisationId);
}

/** For writers outside this module (the organisation purge wipes every key of an org). */
export const notifyByocKeysChanged = notifyChanged;

// ---- validation ----

export const setCredentialInput = z
  .object({
    apiKey: z.string().trim().min(8).max(512),
    secondaryKey: z.string().trim().min(8).max(512).optional(),
  })
  .strict();
export type SetCredentialInput = z.infer<typeof setCredentialInput>;

export const byocModeInput = z.object({ mode: z.enum(['org', 'platform']) }).strict();
export type ByocMode = z.infer<typeof byocModeInput>['mode'];

export function parseProviderId(value: string | undefined): ByocProviderId {
  if (!value || !isByocProviderId(value))
    throw new NotFoundError('Unknown provider for bring-your-own keys', { providerId: value });
  return value;
}

// ---- presentation (never key material) ----

export interface ProviderCredentialView {
  providerId: string;
  hint: string | null;
  state: string;
  lastTestedAt: string | null;
  lastTestResult: { healthy: boolean; reason?: string } | null;
  updatedAt: string;
}

function readTestResult(value: Prisma.JsonValue | null): ProviderCredentialView['lastTestResult'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const healthy = (value as Record<string, unknown>).healthy;
  const reason = (value as Record<string, unknown>).reason;
  if (typeof healthy !== 'boolean') return null;
  return typeof reason === 'string' ? { healthy, reason } : { healthy };
}

export function presentCredential(row: ProviderCredential): ProviderCredentialView {
  return {
    providerId: row.providerId,
    hint: row.hint,
    state: row.state,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastTestResult: readTestResult(row.lastTestResult),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function byocKeyContext(input: {
  organisationId: string;
  providerId: string;
  kind: 'primary' | 'secondary';
}) {
  return {
    purpose: 'studio.byoc_provider_key',
    organisationId: input.organisationId,
    providerId: input.providerId,
    kind: input.kind,
  };
}

// ---- service functions ----

export interface CredentialDeps {
  db: Db;
  keys: DataKeyProvider;
  env?: Env;
  now?: () => number;
}

export async function listCredentials(
  db: Db,
  organisationId: string,
): Promise<ProviderCredentialView[]> {
  const rows = await db.providerCredential.findMany({
    where: { organisationId },
    orderBy: { providerId: 'asc' },
  });
  return rows.map(presentCredential);
}

function checkShape(providerId: ByocProviderId, input: SetCredentialInput, env: Env): void {
  const info = byocProvider(providerId);
  if (info.secondaryKeyLabel && !input.secondaryKey)
    throw new ValidationError(`${info.label} needs both keys`, { problems: ['secondaryKey'] });
  if (!info.secondaryKeyLabel && input.secondaryKey)
    throw new ValidationError(`${info.label} takes a single API key`, {
      problems: ['secondaryKey'],
    });
  // default-registry.ts refuses a HeyGen key without an avatar look (a platform setting).
  if (providerId === 'heygen' && !env.HEYGEN_AVATAR_ID?.trim())
    throw new ValidationError('HeyGen keys need HEYGEN_AVATAR_ID configured on the platform');
}

export async function setCredential(
  deps: CredentialDeps,
  tenant: TenantContext,
  providerId: ByocProviderId,
  input: SetCredentialInput,
): Promise<ProviderCredentialView> {
  const env = deps.env ?? process.env;
  assertByocAvailable(tenant, env);
  checkShape(providerId, input, env);
  const organisationId = tenant.organisationId;
  const encryptedKey = await encryptSecret(
    deps.keys,
    input.apiKey,
    byocKeyContext({ organisationId, providerId, kind: 'primary' }),
  );
  const encryptedSecondaryKey = input.secondaryKey
    ? await encryptSecret(
        deps.keys,
        input.secondaryKey,
        byocKeyContext({ organisationId, providerId, kind: 'secondary' }),
      )
    : null;
  const fields = {
    encryptedKey,
    encryptedSecondaryKey,
    hint: input.apiKey.slice(-HINT_CHARS),
    state: BYOC_CREDENTIAL_ACTIVE,
    lastTestedAt: null,
    lastTestResult: Prisma.DbNull,
    createdByUserId: tenant.userId,
  };
  const row = await deps.db.providerCredential.upsert({
    where: { organisationId_providerId: { organisationId, providerId } },
    create: { organisationId, providerId, ...fields },
    update: fields,
  });
  notifyChanged(organisationId);
  return presentCredential(row);
}

async function findActive(db: Db, organisationId: string, providerId: string) {
  const row = await db.providerCredential.findFirst({
    where: { organisationId, providerId, state: BYOC_CREDENTIAL_ACTIVE },
  });
  if (!row?.encryptedKey) throw new NotFoundError('No active key for this provider');
  return row;
}

async function decryptRow(keys: DataKeyProvider, row: ProviderCredential): Promise<ProviderKey> {
  const base = { organisationId: row.organisationId, providerId: row.providerId };
  const apiKey = await decryptSecret(
    keys,
    row.encryptedKey ?? '',
    byocKeyContext({ ...base, kind: 'primary' }),
  );
  const secondaryKey = row.encryptedSecondaryKey
    ? await decryptSecret(
        keys,
        row.encryptedSecondaryKey,
        byocKeyContext({ ...base, kind: 'secondary' }),
      )
    : undefined;
  return secondaryKey ? { apiKey, secondaryKey } : { apiKey };
}

/** Decrypted active keys for an organisation (the registry resolver only). */
export async function loadActiveKeys(
  db: Db,
  keys: DataKeyProvider,
  organisationId: string,
): Promise<ProviderKeyMap> {
  const rows = await db.providerCredential.findMany({
    where: { organisationId, state: BYOC_CREDENTIAL_ACTIVE, encryptedKey: { not: null } },
  });
  const map: ProviderKeyMap = {};
  for (const row of rows) {
    if (isByocProviderId(row.providerId)) map[row.providerId] = await decryptRow(keys, row);
  }
  return map;
}

export interface TestDeps extends CredentialDeps {
  buildAdapters: (keys: ProviderKeyMap, env: Env) => ProviderAdapter[];
}

async function healthOf(
  adapters: ProviderAdapter[],
): Promise<{ healthy: boolean; reason?: string }> {
  if (adapters.length === 0) return { healthy: false, reason: 'no adapter was built for this key' };
  for (const adapter of adapters) {
    const result = await adapter.healthCheck().catch((err: unknown) => ({
      healthy: false,
      reason: err instanceof Error ? err.message : 'health check failed',
    }));
    if (!result.healthy) {
      const reason = `${adapter.providerId}: ${result.reason ?? 'unhealthy'}`;
      return { healthy: false, reason: reason.slice(0, MAX_REASON_CHARS) };
    }
  }
  return { healthy: true };
}

export async function testCredential(
  deps: TestDeps,
  tenant: TenantContext,
  providerId: ByocProviderId,
): Promise<{ healthy: boolean; reason?: string }> {
  const env = deps.env ?? process.env;
  assertByocAvailable(tenant, env);
  const row = await findActive(deps.db, tenant.organisationId, providerId);
  const key = await decryptRow(deps.keys, row);
  const result = await healthOf(deps.buildAdapters({ [providerId]: key }, env));
  await deps.db.providerCredential.updateMany({
    where: { id: row.id, state: BYOC_CREDENTIAL_ACTIVE },
    data: { lastTestedAt: new Date((deps.now ?? Date.now)()), lastTestResult: result },
  });
  return result;
}

export async function revokeCredential(
  deps: Pick<CredentialDeps, 'db' | 'env'>,
  tenant: TenantContext,
  providerId: ByocProviderId,
): Promise<ProviderCredentialView> {
  assertByocAvailable(tenant, deps.env ?? process.env);
  const organisationId = tenant.organisationId;
  const revoked = await deps.db.providerCredential.updateMany({
    where: { organisationId, providerId, state: BYOC_CREDENTIAL_ACTIVE },
    data: { state: BYOC_CREDENTIAL_REVOKED, encryptedKey: null, encryptedSecondaryKey: null },
  });
  if (revoked.count === 0) throw new NotFoundError('No active key for this provider');
  notifyChanged(organisationId);
  const row = await deps.db.providerCredential.findUniqueOrThrow({
    where: { organisationId_providerId: { organisationId, providerId } },
  });
  return presentCredential(row);
}

// ---- per-project override (video_projects.metadata.byoc) ----

export function projectByocMode(metadata: Prisma.JsonValue | null): ByocMode {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    if ((metadata as Record<string, unknown>).byoc === 'platform') return 'platform';
  }
  return 'org';
}

export async function setProjectByocMode(
  deps: Pick<CredentialDeps, 'db' | 'env'>,
  tenant: TenantContext,
  projectId: string,
  mode: ByocMode,
): Promise<{ projectId: string; byoc: ByocMode }> {
  assertByocAvailable(tenant, deps.env ?? process.env);
  const project = await findProject(deps.db, tenant.organisationId, projectId);
  const metadata =
    project.metadata && typeof project.metadata === 'object' && !Array.isArray(project.metadata)
      ? (project.metadata as Prisma.JsonObject)
      : {};
  const updated = await deps.db.videoProject.updateMany({
    where: { id: projectId, organisationId: tenant.organisationId, updatedAt: project.updatedAt },
    data: { metadata: { ...metadata, byoc: mode } },
  });
  if (updated.count === 0)
    throw new ConflictError('Project changed concurrently; reload and retry');
  return { projectId, byoc: mode };
}
