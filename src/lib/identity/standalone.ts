import type { PrismaClient } from '@prisma/client';
import { ForbiddenError, NoOrganisationError, UnauthorizedError } from '../errors';
import type { EntitlementsReader } from '../studio/billing/entitlements-reader';
import {
  assertSameOriginWrite,
  PLATFORM_ORGANISATION_ID,
  type ResolveOptions,
  type TenantContext,
  type TenantRequest,
} from '../tenant';
import type { IdentityProvider } from './provider';
import { capabilitiesFor, capabilitiesForPlatformRole, toPlatformRole } from './role-capabilities';

// Phase 18 §2.2 standalone mode: the tenant comes from a Better Auth session.
//   1. Better Auth session (cookie) — none: 401.
//   2. Cookie-authenticated writes must be same-origin (CSRF, §2.3) — otherwise 403.
//   3. Organisation = x-studio-organisation-id (members only) or the session's active one — no
//      membership at all: 403 no_organisation (the UI routes to onboarding), except platform staff
//      with 2FA on an admin route, who get a staff-only context (20.10).
//   4. Capabilities from the member's role + staff capabilities (2FA required), §2.4 / §2.5.
//   5. planTier and access from entitlements (Track C).
//   6. A 30 s per-process cache per (session, organisation); invalidate(userId) drops a user's
//      entries (role change, ban, removal). Accepted risk: up to 30 s across processes.

export const ORGANISATION_HEADER = 'x-studio-organisation-id';
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 10_000;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * §2.3: sessions idle out after 14 days (Better Auth's rolling expiry, auth/config.ts) and never
 * live longer than 30 days from sign-in (enforced here, on every Studio API request).
 */
export const SESSION_ABSOLUTE_MAX_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthSessionView {
  session: {
    id: string;
    userId: string;
    activeOrganizationId?: string | null;
    impersonatedBy?: string | null;
    createdAt?: Date | string;
  };
  user: { id: string };
}

/** Reads the Better Auth session from request headers (auth.api.getSession in production). */
export type SessionLookup = (headers: Headers) => Promise<AuthSessionView | null>;

export interface IdentityMembership {
  organisationId: string;
  organisationName: string;
  role: string;
  joinedAt: Date;
}

export interface IdentityRecord {
  userId: string;
  platformRole: string | null;
  banned: boolean;
  banExpires: Date | null;
  twoFactorEnabled: boolean;
  deletedAt: Date | null;
  /** Memberships of organisations that are not deleted. */
  memberships: IdentityMembership[];
}

export interface IdentityStore {
  load(userId: string): Promise<IdentityRecord | null>;
}

export function createPrismaIdentityStore(db: PrismaClient): IdentityStore {
  return {
    async load(userId) {
      const user = await db.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          role: true,
          banned: true,
          banExpires: true,
          twoFactorEnabled: true,
          deletedAt: true,
          members: {
            where: { organization: { deletedAt: null } },
            orderBy: { createdAt: 'asc' },
            select: {
              organizationId: true,
              role: true,
              createdAt: true,
              organization: { select: { name: true } },
            },
          },
        },
      });
      if (!user) return null;
      return {
        userId: user.id,
        platformRole: user.role,
        banned: user.banned === true,
        banExpires: user.banExpires,
        twoFactorEnabled: user.twoFactorEnabled === true,
        deletedAt: user.deletedAt,
        memberships: user.members.map((m) => ({
          organisationId: m.organizationId,
          organisationName: m.organization.name,
          role: m.role,
          joinedAt: m.createdAt,
        })),
      };
    },
  };
}

export interface StandaloneIdentityDeps {
  getSession: SessionLookup;
  store: IdentityStore;
  entitlements: EntitlementsReader;
  /** Studio's public origin (APP_URL): cookie writes must come from it. */
  appOrigin: string;
  impersonation?: { enabled: boolean; allowWrites: boolean };
  now?: () => number;
}

interface CacheEntry {
  userId: string;
  context: TenantContext;
  expiresAt: number;
}

function isBanned(record: IdentityRecord, now: number): boolean {
  if (!record.banned) return false;
  return record.banExpires === null || record.banExpires.getTime() > now;
}

export function createStandaloneIdentityProvider(deps: StandaloneIdentityDeps): IdentityProvider {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const impersonation = deps.impersonation ?? { enabled: false, allowWrites: false };

  function remember(key: string, entry: CacheEntry): void {
    cache.delete(key);
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, entry);
  }

  /** Platform staff with 2FA and no organisation, on an admin route (20.10). */
  function staffOnlyContext(view: AuthSessionView, record: IdentityRecord): TenantContext | null {
    const platformRole = toPlatformRole(record.platformRole);
    const capabilities = capabilitiesForPlatformRole(platformRole, record.twoFactorEnabled);
    if (capabilities.length === 0) return null;
    return {
      userId: record.userId,
      organisationId: PLATFORM_ORGANISATION_ID,
      organisation: { id: PLATFORM_ORGANISATION_ID, name: 'PostMind Studio staff' },
      memberships: [],
      capabilities,
      platformRole,
      sessionId: view.session.id,
      ...(view.session.impersonatedBy && { impersonatorUserId: view.session.impersonatedBy }),
      access: 'full',
      staffOnly: true,
    };
  }

  async function build(
    view: AuthSessionView,
    requestedOrg: string | undefined,
    options: ResolveOptions,
  ): Promise<TenantContext> {
    const record = await deps.store.load(view.session.userId);
    if (!record || record.deletedAt || isBanned(record, now())) {
      throw new UnauthorizedError('Session is no longer valid');
    }
    if (record.memberships.length === 0) {
      const staff =
        options.staffWithoutOrganisation && !requestedOrg ? staffOnlyContext(view, record) : null;
      if (staff) return staff;
      throw new NoOrganisationError('Create or join an organisation first');
    }
    let membership: IdentityMembership | undefined;
    if (requestedOrg) {
      membership = record.memberships.find((m) => m.organisationId === requestedOrg);
      if (!membership) throw new ForbiddenError('User is not a member of this organisation');
    } else {
      const active = view.session.activeOrganizationId ?? undefined;
      // The active organisation may have been left or deleted since: fall back to the oldest
      // membership rather than failing (the header switcher then shows where the user is).
      membership =
        record.memberships.find((m) => m.organisationId === active) ?? record.memberships[0];
    }
    if (!membership) throw new NoOrganisationError('Create or join an organisation first');

    const platformRole = toPlatformRole(record.platformRole);
    const entitlements = await deps.entitlements.forOrganisation(membership.organisationId);
    return {
      userId: record.userId,
      organisationId: membership.organisationId,
      organisation: {
        id: membership.organisationId,
        name: membership.organisationName,
        planTier: entitlements.tier,
      },
      memberships: record.memberships.map((m) => ({
        organisationId: m.organisationId,
        role: m.role,
      })),
      capabilities: capabilitiesFor({
        orgRole: membership.role,
        platformRole,
        twoFactorEnabled: record.twoFactorEnabled,
      }),
      platformRole,
      sessionId: view.session.id,
      ...(view.session.impersonatedBy && { impersonatorUserId: view.session.impersonatedBy }),
      access: entitlements.access,
      role: membership.role,
    };
  }

  return {
    mode: 'standalone',
    async resolve(req: TenantRequest, options: ResolveOptions = {}) {
      const headers = new Headers(req.headers);
      const view = await deps.getSession(headers);
      if (!view) throw new UnauthorizedError('Sign in to continue');
      const createdAt = view.session.createdAt ? new Date(view.session.createdAt).getTime() : NaN;
      if (Number.isFinite(createdAt) && now() - createdAt > SESSION_ABSOLUTE_MAX_MS) {
        throw new UnauthorizedError('Session has expired; sign in again');
      }
      // Better Auth sessions are cookie-only here, so every write is a cookie write (§2.3).
      assertSameOriginWrite(req, deps.appOrigin);
      if (view.session.impersonatedBy) {
        if (!impersonation.enabled) throw new UnauthorizedError('Impersonation is disabled');
        if (!impersonation.allowWrites && MUTATING.has((req.method ?? 'GET').toUpperCase())) {
          throw new ForbiddenError('Impersonation sessions are read-only');
        }
      }
      const requestedOrg = headers.get(ORGANISATION_HEADER)?.trim() || undefined;
      // The staff-only context is cached apart: a workspace route must never be served it.
      const scope = options.staffWithoutOrganisation ? 'admin' : '';
      const key = `${view.session.id}\u0000${requestedOrg ?? ''}\u0000${scope}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return cached.context;
      const context = await build(view, requestedOrg, options);
      remember(key, { userId: context.userId, context, expiresAt: now() + CACHE_TTL_MS });
      return context;
    },
    invalidate(userId: string) {
      for (const [key, entry] of cache) if (entry.userId === userId) cache.delete(key);
    },
  };
}

/** Production wiring: Better Auth + Prisma + the configured entitlements reader. */
export async function createStandaloneIdentityProviderFromEnv(): Promise<IdentityProvider> {
  const [{ getAuth }, { prisma }, { entitlementsReaderFromEnv }, { requireEnv }] =
    await Promise.all([
      import('../auth/server'),
      import('../prisma'),
      import('../studio/billing/entitlements-reader'),
      import('../env'),
    ]);
  const auth = await getAuth();
  return createStandaloneIdentityProvider({
    getSession: async (headers) =>
      (await auth.api.getSession({ headers })) as AuthSessionView | null,
    store: createPrismaIdentityStore(prisma),
    entitlements: await entitlementsReaderFromEnv(),
    appOrigin: new URL(requireEnv('APP_URL')).origin,
    impersonation: {
      enabled: process.env.STUDIO_IMPERSONATION_ENABLED === 'true',
      allowWrites: process.env.STUDIO_IMPERSONATION_WRITE === 'true',
    },
  });
}
