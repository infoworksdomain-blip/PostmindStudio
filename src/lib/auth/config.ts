import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { admin, organization, twoFactor } from 'better-auth/plugins';
import type { Logger } from 'pino';
import { AuditAction, type AuditRecord } from '../audit-sink';
import type { AuthEmailParamsFor, AuthEmailTemplate, AuthMailer } from '../email/auth-mailer';
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALES } from '../i18n/locales';
import type { EntitlementsReader } from '../studio/billing/entitlements-reader';
import { readCookie } from '../tenant';
import { isPasswordBreached } from './breached';
import { AUTH_COOKIE_PREFIX } from './cookie';
import { normaliseSecondFactorCode, verifySecondFactor } from './two-factor-disable';
import {
  createArgon2Hasher,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordHasher,
} from './password';
import {
  enforceLimits,
  INVITE_PATH,
  inviteChecks,
  TWO_FACTOR_VERIFY_PATHS,
  twoFactorChecks,
} from './account-rate-limits';
import type { AuthRateLimitStore, RateRule } from './rate-limit-store';
import {
  organisationAccessControl,
  organisationRoles,
  PLATFORM_ADMIN_ROLES,
  platformAccessControl,
  platformRoles,
} from './roles';

// Phase 18 §2.1–§2.5 — the one place Better Auth is configured (plan §8: "our wrapper keeps the
// options in one file"). Pinned better-auth@1.7.6. Option names were checked against the pinned
// package's type definitions (@better-auth/core/dist/types/init-options.d.mts) and these pages,
// all read 2026-09-29:
//   https://www.better-auth.com/docs/adapters/prisma
//   https://www.better-auth.com/docs/integrations/next
//   https://www.better-auth.com/docs/authentication/email-password
//   https://www.better-auth.com/docs/concepts/session-management
//   https://www.better-auth.com/docs/concepts/rate-limit
//   https://www.better-auth.com/docs/plugins/2fa
//   https://www.better-auth.com/docs/plugins/organization
//   https://www.better-auth.com/docs/plugins/admin

export const AUTH_BASE_PATH = '/api/auth';
/** better-auth@1.7.6 plugins/two-factor/constant.mjs (not exported from the package). */
const TWO_FACTOR_COOKIE_NAME = 'two_factor';
export { AUTH_COOKIE_PREFIX } from './cookie';

const DAY_S = 24 * 60 * 60;
/** §2.3: a session idles out after 14 days (rolling expiry, refreshed at most once a day). */
export const SESSION_IDLE_S = 14 * DAY_S;
/** §2.3: and never lives longer than 30 days (enforced by identity/standalone.ts). */
export const SESSION_MAX_AGE_S = 30 * DAY_S;
/** §2.3: revocation reaches other devices within the cookie cache's 60 s. */
export const SESSION_COOKIE_CACHE_S = 60;
/** Sensitive actions (account deletion, 2FA changes) need a sign-in this recent. */
export const SESSION_FRESH_S = 15 * 60;
export const VERIFICATION_TTL_S = DAY_S;
export const RESET_TTL_S = 60 * 60;
export const INVITATION_TTL_S = 7 * DAY_S;
export const MAX_ORGANISATIONS_PER_USER = 10;

/** §5.2 per-IP limits (Better Auth keys them by client IP and path). */
export const AUTH_RATE_RULES: Readonly<Record<string, RateRule>> = {
  '/sign-in/email': { window: 60, max: 5 },
  '/sign-in/social': { window: 60, max: 10 },
  '/sign-up/email': { window: 60, max: 3 },
  '/request-password-reset': { window: 15 * 60, max: 3 },
  '/send-verification-email': { window: 15 * 60, max: 3 },
  '/reset-password': { window: 15 * 60, max: 5 },
  '/change-password': { window: 15 * 60, max: 5 },
  '/change-email': { window: 15 * 60, max: 3 },
  '/two-factor/*': { window: 5 * 60, max: 5 },
  '/organization/invite-member': { window: 60 * 60, max: 20 },
};

/** §5.2 per-email limits, checked in a before-hook (the email is hashed in the key). */
export const EMAIL_RATE_RULES: Readonly<Record<string, RateRule>> = {
  '/sign-in/email': { window: 60 * 60, max: 10 },
  '/request-password-reset': { window: 15 * 60, max: 3 },
  '/send-verification-email': { window: 15 * 60, max: 3 },
};

/** Paths whose body carries a new password: breached-password check (§5.1). */
const NEW_PASSWORD_FIELDS: Readonly<Record<string, 'password' | 'newPassword'>> = {
  '/sign-up/email': 'password',
  '/reset-password': 'newPassword',
  '/change-password': 'newPassword',
};

export interface AuthConfigDeps {
  db: PrismaClient;
  secret: string;
  /** APP_URL (or BETTER_AUTH_URL): the only trusted origin. */
  baseURL: string;
  mailer: AuthMailer;
  logger: Logger;
  rateLimitStore: AuthRateLimitStore;
  entitlements: EntitlementsReader;
  /** Durable audit write (auditLogDurable in production). */
  audit: (record: AuditRecord) => Promise<void>;
  hasher?: PasswordHasher;
  google?: { clientId: string; clientSecret: string };
  signupsEnabled: boolean;
  breachCheck: boolean;
  fetchImpl?: typeof fetch;
  /** Reverse-proxy addresses: X-Forwarded-For is walked right to left past them. */
  trustedProxies: string[];
  impersonationEnabled: boolean;
  /** Secure cookies (HTTPS). */
  secureCookies: boolean;
  /** Drop cached tenant contexts for a user (identity provider). */
  onIdentityChanged?: (userId: string) => void;
}

export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

function toLocale(value: unknown): string {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
    ? value
    : DEFAULT_LOCALE;
}

function localeFromRequest(headers: Headers | undefined): string | undefined {
  const cookie = readCookie(headers?.get('cookie') ?? null, LOCALE_COOKIE);
  return cookie && (LOCALES as readonly string[]).includes(cookie) ? cookie : undefined;
}

/**
 * Outbox idempotency keys (Track B dedupes on them): a token-based email is keyed by a hash of its
 * token (a retried callback never sends twice, the token itself is never stored); an event email
 * by user and minute.
 */
export function tokenEmailKey(kind: string, token: string): string {
  return `auth:${kind}:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
}

export function eventEmailKey(kind: string, userId: string, now: number = Date.now()): string {
  return `auth:${kind}:${userId}:${Math.floor(now / 60_000)}`;
}

type UserWithLocale = { id: string; email: string; name: string; locale?: unknown };

export function buildAuthOptions(deps: AuthConfigDeps) {
  const hasher = deps.hasher ?? createArgon2Hasher();
  const appUrl = deps.baseURL.replace(/\/$/, '');
  const log = deps.logger;

  const send = <T extends AuthEmailTemplate>(
    template: T,
    user: UserWithLocale,
    params: AuthEmailParamsFor<T>,
    idempotencyKey?: string,
  ) =>
    deps.mailer
      .sendAuthEmail(template, user.email, { ...params, name: user.name }, toLocale(user.locale), {
        userId: user.id,
        ...(idempotencyKey && { idempotencyKey }),
      })
      .then(() => undefined)
      .catch((err: unknown) => {
        // Never tell the caller (enumeration) and never lose the error.
        log.error({ err, template, userId: user.id }, '[auth] email could not be queued');
      });

  const audit = (record: AuditRecord) =>
    deps.audit(record).catch((err: unknown) => log.error({ err }, '[auth] audit failed'));

  // The account behind a 2FA verify: the session's user, or (mid sign-in) the user the signed
  // two_factor cookie points at, resolved the same way the plugin does
  // (plugins/two-factor/verify-two-factor.mjs). Null when neither resolves: the endpoint 401s.
  const twoFactorSubject = async (
    ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  ): Promise<string | null> => {
    const session = await getSessionFromCtx(ctx);
    if (session) return session.user.id;
    const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME);
    const signed = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
    if (!signed) return null;
    const pending = await ctx.context.internalAdapter.findVerificationValue(signed);
    return pending?.value ?? null;
  };

  const before = createAuthMiddleware(async (ctx) => {
    const path = ctx.path;
    const body = (ctx.body ?? {}) as Record<string, unknown>;

    // §5.2 per-email limits, on top of Better Auth's per-IP rules.
    const emailRule = EMAIL_RATE_RULES[path];
    if (emailRule && typeof body.email === 'string' && body.email.includes('@')) {
      await enforceLimits(deps.rateLimitStore, [
        { key: `email:${path}:${hashEmail(body.email)}`, rule: emailRule },
      ]);
    }

    // 19.3 per-account 2FA limit (signed in, or the pending sign-in's two_factor cookie).
    if (TWO_FACTOR_VERIFY_PATHS.has(path)) {
      const userId = await twoFactorSubject(ctx);
      if (userId) await enforceLimits(deps.rateLimitStore, twoFactorChecks(userId));
    }

    // 19.3 per-organisation and per-inviter invite limits (HTTP and server-side api calls).
    if (path === INVITE_PATH) {
      const session = await getSessionFromCtx(ctx);
      if (session) {
        const organisationId =
          typeof body.organizationId === 'string'
            ? body.organizationId
            : ((session.session as { activeOrganizationId?: string | null }).activeOrganizationId ??
              null);
        const isMember = organisationId
          ? (await deps.db.member.count({
              where: { organizationId: organisationId, userId: session.user.id },
            })) > 0
          : false;
        await enforceLimits(
          deps.rateLimitStore,
          inviteChecks({ inviterId: session.user.id, organisationId, isMember }),
        );
      }
    }

    // §5.1 breached passwords (fails open inside isPasswordBreached).
    const field = NEW_PASSWORD_FIELDS[path];
    const candidate = field ? body[field] : undefined;
    if (
      deps.breachCheck &&
      typeof candidate === 'string' &&
      candidate.length >= PASSWORD_MIN_LENGTH
    ) {
      if (await isPasswordBreached(candidate, { logger: log, fetchImpl: deps.fetchImpl })) {
        throw new APIError('BAD_REQUEST', {
          message: 'This password has appeared in a data breach. Choose a different one.',
          code: 'PASSWORD_COMPROMISED',
        });
      }
    }

    // §2.3: changing the password always signs out every other session.
    if (path === '/change-password') {
      return { context: { body: { ...body, revokeOtherSessions: true } } };
    }

    // §5.6: disabling 2FA needs a current TOTP or a backup code, not only the password (which
    // the endpoint itself checks). Wrong or missing code: 400 INVALID_TWO_FACTOR_CODE.
    if (path === '/two-factor/disable') {
      const session = await getSessionFromCtx(ctx);
      if (!session) return undefined; // the endpoint answers 401
      const code = normaliseSecondFactorCode(body.code);
      const row = await deps.db.twoFactor.findFirst({
        where: { userId: session.user.id },
        select: { secret: true, backupCodes: true },
      });
      if (!row || !(await verifySecondFactor(row, code, ctx.context.secretConfig))) {
        throw new APIError('BAD_REQUEST', {
          message: 'Enter a code from your authenticator app or one of your backup codes',
          code: 'INVALID_TWO_FACTOR_CODE',
        });
      }
    }

    // §2.5: Better Auth's /admin/* endpoints need a superadmin WITH two-factor authentication.
    if (path.startsWith('/admin/')) {
      const session = ctx.context.session;
      const user = session?.user as { twoFactorEnabled?: boolean | null } | undefined;
      if (!user?.twoFactorEnabled) {
        throw new APIError('FORBIDDEN', {
          message: 'Two-factor authentication is required for staff actions',
          code: 'TWO_FACTOR_REQUIRED',
        });
      }
    }
    return undefined;
  });

  const after = createAuthMiddleware(async (ctx) => {
    const returned = ctx.context.returned;
    const failed = returned instanceof APIError;
    const ip = ctx.request?.headers.get('x-real-ip') ?? undefined;
    const body = (ctx.body ?? {}) as Record<string, unknown>;

    if (ctx.path === '/sign-in/email' && failed) {
      // No address in the audit log: a hash lets staff correlate attempts without the PII.
      const email = typeof body.email === 'string' ? hashEmail(body.email).slice(0, 16) : 'none';
      await audit({
        actorType: 'system',
        action: AuditAction.SignInFailed,
        resource: { type: 'auth_email', id: email },
        metadata: { status: returned.statusCode },
        ip,
      });
      return;
    }
    const user = ctx.context.session?.user ?? ctx.context.newSession?.user;
    if (failed || !user) return;
    if (ctx.path === '/two-factor/enable' || ctx.path === '/two-factor/disable') {
      const enabled = ctx.path === '/two-factor/enable';
      if (!enabled) {
        // §2.3: disabling 2FA signs out every other session.
        const current = ctx.context.session?.session.token;
        const sessions = await ctx.context.internalAdapter.listSessions(user.id);
        const others = sessions.map((s) => s.token).filter((t) => t !== current);
        if (others.length) await ctx.context.internalAdapter.deleteSessions(others);
      }
      await audit({
        actorUserId: user.id,
        action: enabled ? AuditAction.TwoFactorEnabled : AuditAction.TwoFactorDisabled,
        resource: { type: 'user', id: user.id },
        ip,
      });
      void send(
        'twoFactorChanged',
        user as UserWithLocale,
        { enabled: String(enabled) },
        eventEmailKey(enabled ? '2fa-on' : '2fa-off', user.id),
      );
      deps.onIdentityChanged?.(user.id);
    }
    if (ctx.path === '/change-password') {
      await audit({
        actorUserId: user.id,
        action: AuditAction.PasswordChanged,
        resource: { type: 'user', id: user.id },
        ip,
      });
      void send(
        'passwordChanged',
        user as UserWithLocale,
        {},
        eventEmailKey('password-changed', user.id),
      );
    }
  });

  const organisationEvent = (
    action: AuditRecord['action'],
    actorUserId: string,
    organisationId: string,
    resource: AuditRecord['resource'],
    metadata?: Record<string, unknown>,
  ) => audit({ actorUserId, organisationId, action, resource, metadata });

  return {
    appName: 'PostMind Studio',
    baseURL: appUrl,
    basePath: AUTH_BASE_PATH,
    secret: deps.secret,
    database: prismaAdapter(deps.db, { provider: 'postgresql' }),
    trustedOrigins: [new URL(appUrl).origin],
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !deps.signupsEnabled,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: RESET_TTL_S,
      password: { hash: hasher.hash, verify: hasher.verify },
      sendResetPassword: async ({ user, url, token }) => {
        void send('resetPassword', user as UserWithLocale, { url }, tokenEmailKey('reset', token));
      },
      onPasswordReset: async ({ user }) => {
        await audit({
          actorUserId: user.id,
          action: AuditAction.PasswordReset,
          resource: { type: 'user', id: user.id },
        });
        void send(
          'passwordChanged',
          user as UserWithLocale,
          {},
          eventEmailKey('password-reset', user.id),
        );
        deps.onIdentityChanged?.(user.id);
      },
      // §5.3: an existing address gets the same response as a new one; its owner is told.
      onExistingUserSignUp: async ({ user }) => {
        void send(
          'accountExists',
          user as UserWithLocale,
          { signInUrl: `${appUrl}/sign-in`, resetUrl: `${appUrl}/forgot-password` },
          eventEmailKey('account-exists', user.id),
        );
      },
      // The fake user returned for an existing address must look like a real one (twoFactor,
      // admin and Studio fields, in schema order: core, plugins, additional, id).
      customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
        ...coreFields,
        twoFactorEnabled: false,
        role: 'user',
        banned: false,
        banReason: null,
        banExpires: null,
        ...additionalFields,
        id,
      }),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: VERIFICATION_TTL_S,
      sendVerificationEmail: async ({ user, url, token }) => {
        void send('verifyEmail', user as UserWithLocale, { url }, tokenEmailKey('verify', token));
      },
      afterEmailVerification: async (user) => {
        await audit({
          actorUserId: user.id,
          action: AuditAction.EmailVerified,
          resource: { type: 'user', id: user.id },
        });
      },
    },
    user: {
      additionalFields: {
        locale: { type: 'string', required: false, input: true },
      },
      changeEmail: {
        enabled: true,
        // §5.5: a verified user's current address approves the change (and so is told of it);
        // the new address then gets the verification link.
        sendChangeEmailConfirmation: async ({ user, newEmail, url, token }) => {
          // The confirmation link for a change of address (Better Auth changeEmail): the
          // 'emailChangeConfirm' template carries the link; 'emailChanged' is the after-the-fact notice.
          void send(
            'emailChangeConfirm',
            user as UserWithLocale,
            { url, newEmail },
            tokenEmailKey('change-email', token),
          );
        },
      },
      // Account deletion is Studio's own flow (§5.11), not Better Auth's immediate delete.
      deleteUser: { enabled: false },
    },
    session: {
      expiresIn: SESSION_IDLE_S,
      updateAge: DAY_S,
      freshAge: SESSION_FRESH_S,
      cookieCache: { enabled: true, maxAge: SESSION_COOKIE_CACHE_S, strategy: 'compact' },
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        // §2.9: no provider is "trusted": Google links only when it reports email_verified and
        // the local account is verified too (requireLocalEmailVerified, default true).
        trustedProviders: [],
        allowDifferentEmails: false,
      },
    },
    verification: { storeIdentifier: 'hashed' },
    ...(deps.google && {
      socialProviders: {
        google: {
          clientId: deps.google.clientId,
          clientSecret: deps.google.clientSecret,
          // Scopes: Better Auth's Google defaults are exactly openid, email, profile
          // (@better-auth/core/dist/social-providers/google.mjs); no extra scope is added.
          prompt: 'select_account',
          disableImplicitSignUp: !deps.signupsEnabled,
        },
      },
    }),
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: { ...AUTH_RATE_RULES },
      customStorage: deps.rateLimitStore,
    },
    advanced: {
      cookiePrefix: AUTH_COOKIE_PREFIX,
      useSecureCookies: deps.secureCookies,
      // §2.3: Origin checks on cookie requests and callback/redirect URL validation, always.
      // Explicit because 1.7.6 skips the origin check by default when it detects a test runner
      // (context/create-context.mjs: `isTest() ? true : false`).
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress:
        deps.trustedProxies.length > 0
          ? { ipAddressHeaders: ['x-forwarded-for'], trustedProxies: deps.trustedProxies }
          : // Caddy sets X-Real-IP to its client_ip (deploy/vps/caddy/site.caddy.tmpl); a
            // client-sent X-Forwarded-For is never read.
            { ipAddressHeaders: ['x-real-ip'] },
    },
    disabledPaths: deps.impersonationEnabled
      ? []
      : ['/admin/impersonate-user', '/admin/stop-impersonating'],
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            const locale = (user as { locale?: unknown }).locale;
            return {
              data: {
                ...user,
                locale:
                  typeof locale === 'string' && (LOCALES as readonly string[]).includes(locale)
                    ? locale
                    : (localeFromRequest(ctx?.headers) ?? null),
              },
            };
          },
          after: async (user) => {
            await audit({
              actorUserId: user.id,
              action: AuditAction.SignUp,
              resource: { type: 'user', id: user.id },
            });
          },
        },
      },
      session: {
        create: {
          // §5.11: a soft-deleted account (deletion grace) can never start a session.
          before: async (session) => {
            const user = await deps.db.user.findUnique({
              where: { id: session.userId },
              select: { deletedAt: true },
            });
            return user?.deletedAt ? false : undefined;
          },
          after: async (session) => {
            await audit({
              actorUserId: session.userId,
              action: AuditAction.SignIn,
              resource: { type: 'session', id: session.id },
              ip: session.ipAddress ?? undefined,
              userAgent: session.userAgent ?? undefined,
            });
          },
        },
      },
    },
    hooks: { before, after },
    plugins: [
      organization({
        ac: organisationAccessControl,
        roles: organisationRoles,
        creatorRole: 'owner',
        allowUserToCreateOrganization: true,
        // Each organisation starts without a plan; a cap keeps sign-up abuse cheap.
        organizationLimit: MAX_ORGANISATIONS_PER_USER,
        // Deleting an organisation is Studio's own flow (§5.11: purge + grace), not an instant
        // Better Auth delete.
        disableOrganizationDeletion: true,
        invitationExpiresIn: INVITATION_TTL_S,
        requireEmailVerificationOnInvitation: true,
        cancelPendingInvitationsOnReInvite: true,
        // §2.4: the seat limit comes from the plan (checked on invite and on acceptance).
        membershipLimit: async (_user, org) =>
          (await deps.entitlements.forOrganisation(org.id)).limits.seats ?? Number.MAX_SAFE_INTEGER,
        schema: {
          organization: {
            additionalFields: {
              country: { type: 'string', required: false, input: true },
              defaultLocale: { type: 'string', required: false, input: true },
            },
          },
        },
        sendInvitationEmail: async ({ id, email, role, organization: org, inviter }) => {
          await deps.mailer
            .sendAuthEmail(
              'invite',
              email,
              {
                url: `${appUrl}/invite/${encodeURIComponent(id)}`,
                organisationName: org.name,
                inviterName: inviter.user.name,
                role,
              },
              toLocale((inviter.user as UserWithLocale).locale),
              { organisationId: org.id, idempotencyKey: `invite:${id}` },
            )
            .catch((err: unknown) => log.error({ err }, '[auth] invite email not queued'));
        },
        organizationHooks: {
          afterCreateOrganization: async ({ organization: org, user }) => {
            await organisationEvent(AuditAction.OrgCreated, user.id, org.id, {
              type: 'organisation',
              id: org.id,
            });
          },
          afterUpdateOrganization: async ({ organization: org, user }) => {
            if (org) {
              await organisationEvent(AuditAction.OrgRenamed, user.id, org.id, {
                type: 'organisation',
                id: org.id,
              });
            }
          },
          afterCreateInvitation: async ({ invitation, inviter, organization: org }) => {
            await organisationEvent(
              AuditAction.MemberInvited,
              inviter.id,
              org.id,
              { type: 'invitation', id: invitation.id },
              { role: invitation.role },
            );
          },
          afterAcceptInvitation: async ({ member, user, organization: org }) => {
            await organisationEvent(AuditAction.MemberJoined, user.id, org.id, {
              type: 'member',
              id: member.id,
            });
            deps.onIdentityChanged?.(user.id);
          },
          afterUpdateMemberRole: async ({ member, user, organization: org, previousRole }) => {
            await organisationEvent(
              AuditAction.MemberRoleChanged,
              user.id,
              org.id,
              { type: 'member', id: member.id },
              { from: previousRole, to: member.role },
            );
            deps.onIdentityChanged?.(member.userId);
          },
          afterRemoveMember: async ({ member, user, organization: org }) => {
            await organisationEvent(AuditAction.MemberRemoved, user.id, org.id, {
              type: 'member',
              id: member.id,
            });
            deps.onIdentityChanged?.(member.userId);
          },
        },
      }),
      twoFactor({
        issuer: 'PostMind Studio',
        // §5.6: 10 single-use backup codes, encrypted at rest with the auth secret (the library
        // compares the decrypted list, so hashing them is not possible in 1.7.6).
        backupCodeOptions: { amount: 10, storeBackupCodes: 'encrypted' },
      }),
      admin({
        ac: platformAccessControl,
        roles: platformRoles,
        defaultRole: 'user',
        adminRoles: PLATFORM_ADMIN_ROLES,
        impersonationSessionDuration: 30 * 60,
        allowImpersonatingAdmins: false,
      }),
      // Must stay last: sets cookies from server actions.
      nextCookies(),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(deps: AuthConfigDeps) {
  return betterAuth(buildAuthOptions(deps));
}

export type StudioAuth = ReturnType<typeof createAuth>;
