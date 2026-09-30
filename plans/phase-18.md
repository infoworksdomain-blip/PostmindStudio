# Phase 18: PostMind Studio as a standalone SaaS

Operator decisions of 2026-09-29, summarised: Studio becomes a standalone product. It has its own sign-in (a vetted library), Stripe subscriptions, and Resend for transactional email. Core and Engagement stay as optional adapters, off by default. Hosting is one Hetzner VPS with R2 and AWS KMS. **These decisions override CLAUDE.md** where it says "Auth: JWT issued by PostMind Core", "Do not build authentication UI", "Do not build the payment / billing system" and "Do not build the Engagement Meta OAuth flow". Track E updates CLAUDE.md to match. Rule 1 still holds: Core and Engagement code is never modified.

Research note: web tools were not available when this plan was written (2026-09-29). Library, Meta, Stripe and Resend facts come from knowledge up to mid-2026. §2.1 lists the doc URLs that Track A, C and D owners must re-read on day 1. Any difference found goes in PROGRESS.md before code relies on it.

## 0. Modes

`STUDIO_MODE=standalone` is the default. `STUDIO_MODE=core` keeps today's behaviour. Each integration can also be chosen on its own:

| Setting | standalone default | core |
|---|---|---|
| `STUDIO_IDENTITY_MODE` | `standalone` (Better Auth) | `core` (JWKS JWT + Core context, today's tenant.ts) |
| `STUDIO_AUDIT_SINK` | `local` | `core` (today) or `both` |
| `STUDIO_EMAIL_PROVIDER` | `resend` | `core`, or `none` |
| `STUDIO_META_CONNECT` | `studio` (own OAuth) | `core` (internal push, today) |
| `STUDIO_BILLING` | `stripe` | `core` (planTier comes from Core, usage events go to Core) |
| `STUDIO_BUSINESSES` | `local` | `core` (pending directory, today) |
| `ENGAGEMENT_INTERNAL_URL` | unset, so off | set, so attribution and trigger are on |
| `STUDIO_INTERNAL_SERVICE_TOKEN` | unset, so every `/internal/**` answers 404 (already built) | set |

## 1. Inventory of every Core and Engagement dependency

| # | File(s) | What it does today | Standalone replacement |
|---|---|---|---|
| 1 | `src/lib/tenant.ts` (`createTenantResolver`, `fetchCoreContext`, `extractToken`) | Verifies Core's RS256 JWT (bearer or `POSTMIND_SESSION_COOKIE`) against `POSTMIND_JWKS_URL`. Reads org, memberships, capabilities and planTier from Core `/api/internal/context/:userId` (5-minute cache). Same-origin check on cookie writes. | `IdentityProvider` interface (§2.2). `StandaloneIdentityProvider` reads the Better Auth session, the active organisation, the local membership role, capabilities from the role map, and planTier from entitlements. `CoreIdentityProvider` wraps today's code unchanged. `extractToken`'s Origin / Sec-Fetch-Site check is reused for Studio API writes. |
| 2 | `src/lib/rbac.ts` (`requireCapability`, `requirePlatformStaff`, `STUDIO_PLATFORM_ORG_IDS`) | Capabilities are granted by Core. Staff means an org id in the env list. | Role-to-capability map (§2.4). Staff means `user.role ∈ {staff, superadmin}` with 2FA on (§2.5). The org-id list stays for core mode. |
| 3 | `src/lib/audit.ts` (`deliverAuditEntry`, `POSTMIND_AUDIT_URL`) | Fire-and-forget POST to Core's audit service. | `AuditSink` interface with `LocalAuditSink` (`studio.audit_log`, append-only, §2.6) and `CoreAuditSink` (today's code). `auditLog()` keeps its signature. |
| 4 | `src/lib/studio/api/dev-tenant.ts` | `STUDIO_DEV_TENANT` bypass, `next dev` only. | Kept unchanged. Standalone dev can also just sign up locally. |
| 5 | `src/lib/studio/api/context.ts` (`ApiDeps.resolveTenant`, `core?`, `betaPlans`) | Builds the tenant resolver and the Core directories. | `resolveTenant` comes from the selected `IdentityProvider`. `core.*` gets local implementations (below). New deps: `entitlements`, `billing`, `mailer`, `identity`. |
| 6 | `src/app/api/studio/internal/channels/**`, `internal/tokens/refreshed`, `services/meta-channels.ts` | Core pushes Meta Page and IG tokens after its own Meta login, plus a nightly refresh. | Studio's own Facebook Login for Business flow (§2.10). The internal routes stay; they answer 404 while the service token is unset. |
| 7 | `src/lib/studio/platforms/meta-credentials.ts` | Reads the Core-pushed tokens; its errors say "reconnect in PostMind settings". | Same store (`platform_connections`) filled by Studio's OAuth. Messages become a keyed "reconnect in Connections" message. No refresh is needed, because Page tokens from a long-lived user token do not expire; the 17.3 account-status check still detects revocation. |
| 8 | `src/lib/studio/platforms/meta.ts` (comment line 35) | Publisher on `graph.facebook.com` v26.0 using Core's tokens. | Unchanged. The tokens now come from Studio's OAuth. |
| 9 | `src/lib/studio/core/business-directory.ts`, `app/api/studio/businesses/route.ts`, `services/businesses.ts` | The business list is owned by Core; GET answers 501; `businessId` is an unverified string. | `studio.businesses` table plus `LocalBusinessDirectory`, full CRUD, and `businessId` validated on writes (§2.11). DELETE goes through the existing `business-purge.ts` flow. |
| 10 | `src/lib/studio/core/channel-directory.ts`, `services/channel-reconciliation.ts`, `admin/channels/reconciliation` | Reconciliation against Core's (not yet built) channel list. | Studio is now the source of truth. The directory stays `ready:false` in standalone and the admin endpoint answers "not applicable in standalone mode". |
| 11 | `src/lib/studio/core/organisation-directory.ts`, `organisation-reconciliation.ts` | Nightly check for orphan organisations, waiting on Core. | `LocalOrganisationDirectory.existing()` reads `studio.organisations` where not deleted. The job runs for real. |
| 12 | `src/lib/studio/core/usage-reporter.ts`, `services/usage-events.ts` | Outbox of usage events for Core billing, waiting on Core. | Standalone billing is flat tiers plus top-ups, so nothing is reported. Rows stay in the outbox as the local usage record with state `local`, and the flush job is off. `STUDIO_BILLING=core` sends them as today. |
| 13 | `src/lib/studio/core/calendar-shadow-client.ts`, `services/calendar-shadows.ts` | Shadow entries for Core's calendar. | Off: Studio's own `/calendar` page is the calendar. Rows are not written in standalone. |
| 14 | `src/lib/studio/core/content-client.ts`, `internal/projects/from-content`, `services/content-projects.ts`, `POSTMIND_CONTENT` source type | "Make a video from this post", reading Core content. | Stays a Core-only adapter. The UI hides the `POSTMIND_CONTENT` entry in standalone. Brief, website scan and upload cover the same use. |
| 15 | `src/lib/studio/core/engagement-trigger.ts`, `platforms/publishing.ts` (EngagementClient), `pipeline/create-deps.ts:147-151` | Attribution POST to Engagement, plus trigger fields behind a flag. | Unchanged; off while `ENGAGEMENT_INTERNAL_URL` is unset. |
| 16 | `src/lib/studio/analytics/engagement-sentiment.ts`, `api/studio/analytics/engagement-conversations`, `internal/publications/[id]/attribute-conversation` | Engagement sentiment and conversation attribution. | Unchanged, optional and off. The UI hides the Engagement analytics panel while off. |
| 17 | `src/lib/studio/notifications/email.ts` (`CoreEmailSender`, `STUDIO_EMAIL_PROVIDER`) | Email is "pending setup". | `ResendEmailSender` (Track B). The `resend` value becomes valid. |
| 18 | `services/beta.ts` (`applyBetaPlan`) | Raises Core's tier to PLUS during beta. | Kept. It is applied on top of the Stripe-derived tier. |
| 19 | `services/plan-quotas.ts` (`lastRecordedTier`, "Core's tier is only known per request"), `services/cost-caps.ts` (admin report) | Tier is guessed for staff views. | `org_entitlements.tier` is stored, so admin views read the real tier. |
| 20 | `services/organisation-purge.ts`, `internal/organisations/[id]/purge` | Core calls purge when an org is deleted. | Called locally from org delete and account delete (§5.9). |
| 21 | `services/business-purge.ts`, `internal/businesses/[id]/purge` | Core calls it on `business.deleted`. | Called from the local DELETE `/businesses/:id`. |
| 22 | `integrations/core/*` (OpenAPI, client, contract suite) | The Core integration kit. | Kept for core mode. README gains a "standalone mode" note. |
| 23 | `src/components/studio/connections/meta-platform-card.tsx`, `connections-screen.tsx`, `platforms.ts`, `review-screen.tsx`, `create/auto-publish-option.tsx`, `account/export-screen.tsx`, `templates-screen.tsx`, `share/public-preview.tsx` | Copy and links pointing to "PostMind settings" or Core. | Standalone copy: a Meta "Connect" button, no Core links. Keyed per Phase 16. |
| 24 | `src/app/page.tsx` | `/` redirects to `/projects`. | `/` becomes the marketing landing page; signed-in users are redirected to `/projects`. |
| 25 | `demo/tour/not-built-data-*.ts` | Register: email, business list, channel reconciliation, Core Meta wiring. | Update the entries to "built (standalone)" or "core mode only". |
| 26 | `.env.example`, `deploy/vps/.env.example` (vps-deploy branch), `runbooks/vps-deploy.md` ("the Core team (Core URLs and tokens)") | The Core variables are required. | Core variables become optional; new auth, billing, email and Meta variables are added (§6). |

## 2. Target architecture

### 2.1 Auth library choice

| | Better Auth (recommended) | Auth.js v5 (next-auth@5) | Lucia-style hand-rolled (Oslo / @oslojs + own tables) |
|---|---|---|---|
| Email and password, verification, reset | Built in (`emailAndPassword`, `requireEmailVerification`, `sendResetPassword`) | Credentials provider only; no verification, reset or lockout; the docs discourage it | You write all of it |
| Google | Built-in social provider, account linking with a trusted-provider list | Yes | You write it (arctic / oslo) |
| TOTP 2FA and backup codes | `twoFactor` plugin | No | You write it (@oslojs/otp) |
| Sessions | Database sessions, token rotation, a list of active sessions and revoke, short-lived signed cookie cache | JWT or database via adapter | You write it |
| Organisations, members, invites, roles | `organization` plugin (invitations, roles, active organisation on the session, membership limits, hooks) | No | You write it |
| Platform admin and impersonation | `admin` plugin (user role, ban, impersonate with `impersonatedBy`) | No | You write it |
| Rate limiting | Built in, per-path rules, secondary storage (Redis/Valkey) | No | You write it |
| Prisma 6 plus the `studio` schema | Prisma adapter; model and field names configurable, so models carry `@@schema("studio")` / `@@map` | Prisma adapter | Your own |
| Next.js 15 App Router | `toNextJsHandler`, `nextCookies()` plugin, `auth.api.getSession({ headers })` in route handlers and RSC | Yes | Your own |
| Status (to re-verify) | Actively developed, MIT. Auth.js maintenance moved to the Better Auth team in 2025. | v5 was long in beta; now maintenance mode | Lucia v3 deprecated (2025); now a learning resource |
| Security code we own | Small: hooks and our capability map | Large (the whole credentials lifecycle) | Largest |

**Decision: Better Auth**, pinned to an exact version with Renovate PRs. Password hashing is argon2id through `emailAndPassword.password.{hash, verify}` using `@node-rs/argon2`. OWASP parameters: m=19456 KiB, t=2, p=1. The library default is scrypt.

Why not the others:
- Auth.js would leave verification, reset, 2FA, organisations and rate limits for us to build.
- Hand-rolling would mean owning all of it, which conflicts with the rules "prefer battle-tested libraries" and "never fake a working feature".

URLs to re-verify on day 1 (not fetched on 2026-09-29):
- Better Auth: https://www.better-auth.com/docs/introduction, /docs/adapters/prisma, /docs/integrations/next, /docs/plugins/organization, /docs/plugins/2fa, /docs/plugins/admin, /docs/concepts/rate-limit, /docs/concepts/session-management, /docs/concepts/cookies, /docs/reference/security, /docs/reference/options (`disabledPaths`, `trustedOrigins`, `advanced.ipAddress`)
- Auth.js: https://authjs.dev/getting-started/migrating-to-v5 and the Better Auth blog post announcing it took over Auth.js
- Lucia: https://lucia-auth.com and the deprecation announcement on github.com/lucia-auth/lucia
- OWASP: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html

Day-1 spike (half a day, Track A): confirm the following in the pinned version.
1. The Prisma adapter works with `@@schema("studio")`.
2. The option names used below exist: `disabledPaths`, `membershipLimit`, `organizationHooks` / `databaseHooks`, `cookieCache`, `ipAddressHeaders`, `accountLinking.trustedProviders`.
3. The 2FA secret is encrypted at rest.

Where an option is missing, the fallback is noted inline.

### 2.2 IdentityProvider: where `requireTenantContext` and `requireCapability` get their data

New file `src/lib/identity/provider.ts`:
```ts
export interface IdentityProvider {
  readonly mode: 'standalone' | 'core';
  resolve(req: TenantRequest): Promise<TenantContext>;   // 401 / 403 as today; never fails open
}
// TenantContext gains optional fields (existing consumers unchanged):
//   platformRole?: 'user' | 'staff' | 'superadmin';
//   sessionId?: string; impersonatorUserId?: string;
//   access?: 'full' | 'read_only' | 'none';   // from entitlements (§P.3)
//   role?: string;                             // org role (owner/admin/…)
```

- **Standalone** (`src/lib/identity/standalone.ts`):
  1. Load the session with `auth.api.getSession({ headers })`; none means 401.
  2. For a cookie-authenticated mutation, run the `extractToken` same-origin check (Origin equals `APP_URL`, otherwise `Sec-Fetch-Site: same-origin`); otherwise 403.
  3. The organisation is `session.activeOrganizationId`, overridable by an `x-studio-organisation-id` header only when the user is a member. None means 403 `no_organisation`, and the UI routes to onboarding.
  4. Load the membership role from `studio.members` and map it to capabilities (§2.4). Staff capabilities are added from `user.role` (§2.5).
  5. planTier and access come from `EntitlementsReader.forOrganisation(orgId)` (Track C; returns `{tier:'BASIC', access:'none'}` until C lands).
  6. Cache: a per-process LRU of 30 s per `(sessionId, orgId)`. Role changes and bans call `invalidate(userId)`, and Better Auth's session revocation covers the rest. Accepted risk: up to 30 s across processes (today it is 5 minutes).
- **Core**: `createTenantResolver` from tenant.ts, unchanged, wrapped.
- `requireTenantContext(req)` keeps its name and signature and delegates to the configured provider. `withStudioRoute` is unchanged apart from one new step after `requireCapability`: `assertAccess(tenant, req.method, path)`, which enforces billing read-only / none with an allowlist (§P.3).

### 2.3 Sessions, cookies, CSRF

- The cookie prefix is `studio`, so the cookie is `__Secure-studio.session_token`: HttpOnly, Secure, SameSite=Lax, Path=/.
- Session lifetime is 30 days, rolling (`updateAge` 1 day). Idle sessions expire after 14 days (enforced in a `session` hook). Sessions are stored in `studio.sessions` with IP and UA.
- The cookie cache is 60 s, so revocation takes at most 60 s.
- A new session token is issued on sign-in, on 2FA completion, and on password or email change. Other sessions are revoked on password change and on 2FA disable. Session fixation is covered by this and by the library never accepting a client-supplied token.
- CSRF defence is layered:
  - SameSite=Lax.
  - Better Auth's Origin check on `/api/auth/*`, with `trustedOrigins=[APP_URL]`.
  - Studio's existing same-origin check on cookie-authenticated `/api/studio/*` mutations.
  - GET handlers never mutate.
- Client IP comes from `X-Forwarded-For` set by Caddy (`CADDY_TRUSTED_PROXIES` already exists), configured in `advanced.ipAddress.ipAddressHeaders`. A test asserts that a spoofed XFF from outside does not change the rate-limit key.
- `src/middleware.ts` (new, edge) only redirects page loads with no session cookie to `/sign-in?next=`. It is optimistic; the real check is server-side.

### 2.4 Organisation, membership, invite and role model

This is the Better Auth `organization` plugin, stored in `studio.organisations`, `studio.members` and `studio.invitations`. Each user has one active organisation per session and can switch organisations from the header.

New capabilities in `rbac.ts`:
- `studio:org:manage`, `studio:org:delete`, `studio:members:manage`, `studio:billing:read`, `studio:billing:manage`, `studio:business:manage`, `studio:audit:read`
- Admin: `studio:admin:organisations`, `studio:admin:users`, `studio:admin:billing`, `studio:admin:impersonate`

| Capability | owner | admin | publisher | creator | viewer |
|---|---|---|---|---|---|
| project:read / render:download | ✓ | ✓ | ✓ | ✓ | read only |
| project:write | ✓ | ✓ | ✓ | ✓ | – |
| project:approve, publication:write | ✓ | ✓ | ✓ | – | – |
| render:force-approve, connections:manage, business:manage | ✓ | ✓ | – | – | – |
| members:manage, org:manage, audit:read, billing:read | ✓ | ✓ (cannot change owners) | – | – | – |
| billing:manage, org:delete | ✓ | – | – | – | – |

The viewer column is read only: it gets project:read but not render:download.

Rules:
- No org role ever gets a `studio:*` or `studio:admin:*` wildcard. A test asserts this.
- The last owner cannot leave or be demoted; ownership can be transferred.
- Invites carry the email address and a role, and expire after 7 days. They are accepted only by a signed-in user whose **verified** email matches.
- The seat limit is checked when the invite is created and again on acceptance (`membershipLimit` function reading entitlements; fallback: a `beforeCreateInvitation` hook).
- Invites and role changes are audited.
- Approvals: the existing `ProjectApprove` separation (creators cannot self-approve) keeps working because creators lack the capability.

### 2.5 Platform staff (super-admin)

- The Better Auth `admin` plugin sets `user.role` to `user`, `staff` or `superadmin`.
  - `staff` gets `studio:admin:kill-switch:read`, `:providers`, `:library` and `:moderation`.
  - `superadmin` gets `studio:admin:*`.
- Staff capabilities are granted only when the user has 2FA enabled. `requirePlatformStaff(context)` in standalone mode checks `context.platformRole`; core mode keeps the org-id list.
- Bootstrap uses the CLI `scripts/auth/create-superadmin.ts --email <addr>`. It creates the user (or promotes an existing one) and emails a set-password link. There is no env-seeded password.
- Role changes happen only through the CLI or a superadmin, and are audited.
- **Impersonation is off** (`STUDIO_IMPERSONATION_ENABLED=false`). When turned on:
  - superadmin only, 2FA required, and a reason is required;
  - 30-minute sessions shown with a banner;
  - read-only by default (mutations answer 403 unless `STUDIO_IMPERSONATION_WRITE=true`);
  - every request audited with `impersonatorUserId`;
  - staff can never impersonate other staff.

### 2.6 Local audit log

- Table `studio.audit_log`: `id`, `occurredAt`, `actorUserId`, `actorType` (user / staff / system / stripe / meta), `impersonatorUserId`, `organisationId?`, `action`, `resourceType`, `resourceId`, `metadata` (JSONB, no PII), `ip`, `userAgent`, `correlationId`. Indexed on (organisationId, occurredAt) and (actorUserId, occurredAt).
- A database trigger rejects UPDATE and DELETE unless `SET LOCAL studio.audit_retention = 'on'`. Only the retention job sets it. Default retention is 2 years (`STUDIO_AUDIT_RETENTION_DAYS=730`).
- `auditLog()` stays fire-and-forget. `auditLogDurable()` awaits the write and is used for auth, billing, membership, consent and deletion events. The pino logger is the fallback.
- On org hard delete, the org's audit rows are kept, as the existing rule says: "the audit trail itself is never deleted". They hold ids only.
- Owners and admins get `/settings/audit` (paginated, filtered to their org). Staff see all.
- New actions: `auth.sign_in`, `auth.sign_in_failed` (rate-limited logging), `auth.password_reset`, `auth.2fa_enabled|disabled`, `auth.session_revoked`, `member.invited|joined|role_changed|removed`, `org.created|renamed|deleted`, `billing.checkout_started|subscription_changed|payment_failed|topup_purchased`, `entitlement.override_set`, `staff.impersonation_started|ended`, `meta.connected|disconnected`, `business.created|deleted`.

### 2.7 Stripe

- **Catalogue.** One Product per self-serve tier (BASIC, STANDARD, PLUS), each with product metadata `studio_tier`. Two Prices per product in GBP (monthly and yearly, `tax_behavior=exclusive`) with lookup keys `studio_basic_monthly`, `studio_basic_yearly`, and so on. Top-up Products use one-time Prices with lookup keys `studio_topup_short10_basic`, `studio_topup_short10_standard`, `studio_topup_short10_plus`, `studio_topup_long2_standard`, `studio_topup_long2_plus`.
- **Mapping lives in code, amounts live in Stripe.** `src/lib/studio/billing/catalogue.ts` maps lookup key to tier or pack. The pricing page reads amounts with `prices.list({lookup_keys, expand:['data.product']})`, cached 10 minutes. The operator changes a price by creating a new Price and moving the lookup key over (`transfer_lookup_key`), with no deploy. Existing subscribers keep their old Price until migrated in Stripe.
- **Checkout** (`POST /api/studio/billing/checkout`, capability `billing:manage`):
  - `mode=subscription` with the price for the lookup key, plus `customer` (created once per org and stored in `billing_customers`).
  - Tax: `automatic_tax.enabled=true`, `tax_id_collection.enabled=true`, `billing_address_collection=required`, `customer_update={address:'auto',name:'auto'}`.
  - `subscription_data.metadata.organisationId`, and `trial_period_days` only if the org has never trialled.
  - `payment_method_collection=always`, `client_reference_id=orgId`, `locale` from the user, and success / cancel URLs on `APP_URL`.
  - Outbound Stripe create calls carry `Idempotency-Key` values derived from (orgId, intent, a nonce kept in `billing_customers`).
- **Customer Portal** (`POST /billing/portal`): a session for the customer. The portal configuration is created by a script (`scripts/billing/portal-config.ts`):
  - payment methods, invoices and tax ids enabled;
  - plan switching among the 3 products;
  - downgrades and interval changes applied at the end of the billing period;
  - cancel at period end with a reason survey.
- **Webhook** at `POST /api/billing/stripe/webhook`. It is public, has no tenant, and is excluded from the middleware.
  - Read the raw body with `await req.text()`, then `stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET)` with the default 300 s tolerance. A bad signature gets 400 and is logged with no body.
  - Dedupe on `stripe_events.id` (an insert that does nothing on conflict), then process.
  - Out-of-order safety: for subscription and invoice events, **re-fetch** the subscription from the API and upsert its current state, ignoring event payload ordering. Reply 2xx quickly; failures leave `processedAt` null and a sweeper re-processes them.
  - Events handled:
    - `checkout.session.completed`: subscription mode links customer, subscription and org; payment mode (top-ups) credits the account when `payment_status=paid`.
    - `checkout.session.async_payment_succeeded` / `async_payment_failed`
    - `customer.subscription.created`, `.updated`, `.deleted`
    - `customer.subscription.trial_will_end` (sends the trial-ending email)
    - `invoice.paid` (clears the grace period)
    - `invoice.payment_failed` (starts the grace period, emails owners)
    - `invoice.payment_action_required` (SCA email with the hosted invoice link)
    - `customer.updated` (tax id and address)
    - `charge.refunded` (a top-up refund removes the unused credits)
    - `charge.dispute.created` (notifies staff, audited)
- **Entitlements.** The subscription (status, lookup key, period, cancel_at_period_end, trial_end) is turned into `org_entitlements` (tier, access, source) by a pure function, `entitlementsFromSubscription()`. That function is the one place Stripe state becomes Studio state (§P.3).
- **Trials:** see §P.3. Abuse control: the card fingerprint on the subscription's default payment method is checked against `trial_fingerprints`. If it has been seen before, the trial is ended at once (`subscriptions.update(trial_end:'now')`).
- **Dunning.** Stripe Smart Retries and Stripe's failed-payment emails are enabled in the dashboard. Studio adds a localised in-app banner and its own email to owners. Grace and read-only rules are in §P.3. When Stripe marks the subscription `unpaid` or `canceled` after retries, access becomes read-only.
- **Stripe Tax.** Registrations (UK VAT; EU OSS if selling to EU consumers) are set by the operator. Prices are tax-exclusive and the pricing page says "excl. VAT".

### 2.8 Resend

- `ResendEmailSender implements EmailSender` (`provider: 'resend'`). An `email_outbox` row holds the idempotency key (`notificationId` or `auth:<verificationId>`). A BullMQ `send-email` queue retries 5 times with backoff. Resend's idempotency header is used where the pinned SDK supports it; the outbox dedupes either way.
- **Templates:** React Email components in `src/emails/*` rendered on the server with next-intl messages from `messages/<locale>.json` → `email.*` namespace, in all 11 locales, en-GB fallback, with HTML and plain-text parts.
  - Transactional: `verifyEmail`, `resetPassword`, `passwordChanged`, `emailChangeConfirm` (sent to the new address) and `emailChanged` (notice to the old one), `accountExists` (sent when someone signs up with an existing email), `twoFactorChanged`, `newSignIn` (optional, off by default).
  - Organisation: `invite`, `ownershipTransferred`.
  - Billing: `trialEnding`, `paymentFailed`, `paymentActionRequired`, `subscriptionChanged`, `subscriptionCanceled`, `topupReceipt` (Stripe sends invoices and receipts itself).
  - Account: `accountDeletionScheduled`, `orgDeletionScheduled`, `dataExportReady`.
  - `notification`: one generic template rendering the existing `notifications.*` key and params (16.5), so every in-app notification kind can be emailed.
- The locale is `users.locale`, set at sign-up from the `studio.locale` cookie and editable in the profile.
- **Webhooks** at `POST /api/email/resend/webhook`: Svix-style signature verified with `standardwebhooks` (already in node_modules) and `RESEND_WEBHOOK_SECRET`. Events: `email.delivered` and `email.delivery_delayed` update the outbox; `email.bounced` (hard) and `email.complained` add a row to `email_suppressions` keyed by the SHA-256 of the lowercased address, so a suppression outlives account deletion.
- **Suppressed addresses** get no email; the UI shows "we can't email you". Auth emails to a suppressed address show a support contact instead.
- **Notification preferences.** The existing `EmailPreferenceLookup.emailRecipients()` returns user ids. The sender resolves addresses from `studio.users` and drops unverified or suppressed ones. Non-transactional mail carries `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). The link is an HMAC token (`STUDIO_UNSUBSCRIBE_SECRET`) whose endpoint turns email off for that notification kind in `notification_preferences`. Auth and billing mail cannot be unsubscribed.
- `runbooks/notifications-email.md` records Option B as chosen.

### 2.9 Google sign-in

- Better Auth social provider `google` with scopes `openid email profile` only, and callback `${APP_URL}/api/auth/callback/google`. Use a separate OAuth client from the YouTube publishing client, whose scopes differ.
- Account linking is allowed only when Google says `email_verified=true`. **Pre-hijack defence:** if the existing local account's email is unverified, its password credential is deleted before linking and the user is told to set a new password.

### 2.10 Meta: Studio's own Facebook Login for Business

Studio already has the OAuth scaffolding: `platforms/oauth.ts`, `oauth-state.ts` (Redis state), `oauth-init` / `oauth-callback` routes, and `tokens.ts` sealing with KMS. Meta joins them as `OAuthPlatform 'meta'`, a single flow that yields both Facebook Pages and linked Instagram professional accounts.

1. **Init.** `GET https://www.facebook.com/{v}/dialog/oauth?client_id&redirect_uri&state&response_type=code&config_id={META_LOGIN_CONFIG_ID}`. The Facebook Login for Business configuration holds the permissions. State is 32 random bytes stored in Redis for 10 minutes, bound to (userId, orgId, businessId?), and single use. PKCE is added if the current Meta docs support it for this flow; state is mandatory either way.
2. **Callback.** Exchange the code at `GET /{v}/oauth/access_token` (with the app secret, server side), then exchange the result for a long-lived user token (`grant_type=fb_exchange_token`, about 60 days).
3. Call `GET /me/accounts?fields=id,name,access_token,instagram_business_account{id,username}`. Page tokens derived from a long-lived user token do not expire.
4. The user picks which Pages and IG accounts to connect. Each goes through the existing `registerMetaChannel` logic, called locally, with sealed tokens and `connectedVia='studio'`. The user token is discarded after use; nothing that is not needed is stored.
5. Every API call sends `appsecret_proof` (HMAC-SHA256 of the token with the app secret).

Permissions to confirm against the operator's approved app:
- Pages: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`, plus `business_management` if Pages are reached through a Business Manager.
- Instagram: `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`.
- These must have Advanced Access, and the app needs Business Verification.

Required Meta callbacks (new):
- `POST /api/meta/deauthorize`: verify the `signed_request` (HMAC-SHA256 with the app secret), then revoke the matching connections.
- `POST /api/meta/data-deletion`: same verification, then wipe that Meta user's connections and return `{url, confirmation_code}` pointing to a status page.

The alternative, "Instagram API with Instagram Login" (`graph.instagram.com`, `instagram_business_*` scopes), is not chosen because the existing publisher targets `graph.facebook.com` with IG user ids. It can be added later as a second adapter.

Doc URLs to verify:
- developers.facebook.com/docs/facebook-login/facebook-login-for-business
- /docs/instagram-platform/content-publishing
- /docs/pages-api
- /docs/permissions
- /docs/facebook-login/guides/access-tokens/get-long-lived
- /docs/development/create-an-app/app-dashboard/data-deletion-callback
- /docs/graph-api/securing-requests (appsecret_proof)

### 2.11 Businesses

- `studio.businesses`: `id` (cuid), `organisationId`, `name`, `domain?`, `createdByUserId`, `createdAt`, `updatedAt`, `deletedAt`. Unique (organisationId, lower(name)) where not deleted.
- Routes: GET `/businesses` (replaces the 501), POST, PATCH `/businesses/:id`, DELETE `/businesses/:id`. DELETE runs the existing `purgeBusiness` (soft delete, 30-day hard delete).
- The per-tier businesses limit is checked on create (§P.1).
- `LocalBusinessDirectory implements CoreBusinessDirectory` (renamed `BusinessDirectory`, with an alias kept).
- `parseBusinessId` gains `assertBusinessInOrg(db, orgId, id)` on every write route that takes a `businessId`. Existing tables are keyed by (orgId, businessId), so there is no data change.
- The header switcher becomes a picker.

### 2.12 Core feeds and Engagement

As in §1, rows 12–16. Each adapter is chosen once in `context.ts` / `create-deps.ts` by mode, so there are no mode checks scattered through the code.

## 3. New UI (every string in all 11 locales, following Phase 16 rules)

The locales are en-GB, en-US, fr, es, ar (RTL), de, it, pt-BR, pt-PT, hi and zh-Hans. Phase 16 rules apply: next-intl namespaces, ICU plurals, `useFormat()` for money (GBP), logical CSS only, `rtl:-scale-x-100` on directional icons, and error codes mapped to `errors.codes.*`. New namespaces, one owner each: `marketing`, `pricing`, `legal`, `auth`, `orgSettings`, `members`, `billing`, `security`, `upgrade`, `email`, `adminOrgs`, `adminUsers`. `onboarding` and `account` are extended by their owners. Every screen gets ar and zh-Hans render tests. `scripts/i18n/check-catalogues.ts` and `review-list.ts` must be clean.

| Route | Group | Content |
|---|---|---|
| `/` | `(marketing)` | Landing page: product story, sample renders, platform logos, three-step flow, CTA to pricing and sign-up. Signed-in users are redirected to `/projects`. |
| `/pricing` | `(marketing)` | Tier cards plus the full comparison table (§P.4), monthly/annual toggle, "excl. VAT", Enterprise "Contact us" (mailto or form to `STUDIO_SALES_EMAIL`), FAQ. |
| `/legal/{terms,privacy,cookies,acceptable-use,dpa,subprocessors}` | `(marketing)` | Renders operator Markdown from `content/legal/<locale>/<doc>.md`, falling back to en-GB with a note that it is not translated. A placeholder banner shows until the operator supplies text. Production sign-up refuses to open while terms or privacy is still the placeholder (`STUDIO_LEGAL_READY` check). |
| `/sign-up`, `/sign-in`, `/verify-email`, `/forgot-password`, `/reset-password`, `/two-factor`, `/invite/[token]` | `(auth)` | Email and password plus "Continue with Google". Password strength meter with a breached-password check. Generic messages (§5). TOTP or backup-code challenge. Invite acceptance. |
| `/welcome` (existing, extended) | `(studio)` | Onboarding: (1) create organisation (name, country for tax, locale); (2) choose plan, start trial, go to Checkout; (3) first business; (4) connect accounts (Meta, TikTok, YouTube, X, LinkedIn); (5) the existing brand-kit and first-video steps. |
| `/settings/organisation` | `(studio)` | Name, logo, default locale; transfer ownership; delete organisation (type the name, re-authenticate, 2FA if on). |
| `/settings/members` | `(studio)` | Members table (role select, remove), pending invites (resend, revoke), seat meter, upgrade prompt at the limit. |
| `/settings/billing` | `(studio)` | Current plan and status (trial, active, past due with grace countdown, read-only, cancelling), renewal date, usage meters (short, long, images per business, scans, seats, businesses, storage, cost this month vs cap), top-up packs, invoices (Stripe list with PDF links), "Manage billing" (portal), plan change. |
| `/settings/audit` | `(studio)` | The organisation's audit log. |
| `/account/profile`, `/account/security` | `(studio)` | Name, locale, email change; password change, 2FA enrol (QR plus manual key) and disable, backup codes, active sessions with revoke, linked Google, delete account. The existing `/account/export` stays. |
| `/admin` tabs: Organisations, Users, Subscriptions | `(studio)` | Organisations: search, tier, status, MRR, cost this month; detail page with members, subscription, entitlement overrides, the existing beta / policy / cost-caps / usage / purge-plan. Users: search by email, verified, 2FA, role, sessions, ban, force reset, reset 2FA (audited). Subscriptions: status filters, past-due list. Impersonate button only when enabled. |

Cross-cutting UI:
- A global `UpgradeDialog` opens on API errors `plan_tier` (shows `details.requiredTier`), `quota_exceeded`, `plan_required` and `billing_required`.
- The existing quota banner gains "Upgrade" and "Buy top-up" CTAs.
- A read-only / past-due banner appears in `AppShell`.
- The organisation switcher and user menu (sign out) appear in the header.

Demo: new mock handlers `demo/api/handlers/p18-*.ts` (auth session, org, members, billing, pricing), the "Not built" register updated, and a "What's new" entry.

## 4. Data model (expand-only, one migration in Track 0)

New models, all `@@schema("studio")`:
- **Better Auth core:** `User` → `users` (+ `locale`, `role`, `banned`, `banReason`, `banExpires`, `twoFactorEnabled`, `deletedAt`), `Session` → `sessions` (+ `activeOrganizationId`, `impersonatedBy`), `Account` → `auth_accounts` (the password hash lives here), `Verification` → `verifications`, `TwoFactor` → `two_factors`.
- **Organisations:** `Organization` → `organisations` (+ `country`, `defaultLocale`, `deletedAt`), `Member` → `members`, `Invitation` → `invitations`.
- **Studio:**
  - `Business` → `businesses`
  - `AuditLog` → `audit_log` (plus the trigger, in raw SQL in the migration)
  - `BillingCustomer` → `billing_customers` (orgId PK, stripeCustomerId unique)
  - `Subscription` → `subscriptions` (Stripe id PK, orgId, status, lookupKey, interval, periodStart/End, cancelAtPeriodEnd, trialEnd, stripeUpdatedAt)
  - `OrgEntitlement` → `org_entitlements` (orgId PK, tier, access, source `stripe|trial|admin|core|none`, graceUntil, overrides JSONB, updatedAt, updatedByUserId)
  - `UsageCredit` → `usage_credits`
  - `UsageCreditUse` → `usage_credit_uses` (unique projectId + month)
  - `StripeEvent` → `stripe_events`
  - `TrialFingerprint` → `trial_fingerprints`
  - `EmailOutbox` → `email_outbox`
  - `EmailSuppression` → `email_suppressions`
- **Changes to existing tables (additive only):**
  - `platform_connections.connectedVia String?` (`core|studio`)
  - `usage_events` state gains `local` (a text column, so no enum migration if it is a string; otherwise add the enum value)
  - `notification_preferences`: nothing.

Effect on the ~45 existing tables that store `organisationId`, `userId` or `*ByUserId` as plain strings: **no change, and no foreign keys are added**.
- In standalone mode the values are Better Auth ids (≤ 128 characters, matching the existing zod `max(128)`).
- In core mode they stay Core ids. No FKs means both modes share one schema, and purge and hard-delete keep working table by table.
- Referential integrity comes from the IdentityProvider (every request is scoped to a real org) and the nightly `LocalOrganisationDirectory` reconciliation.
- There is no production data today (VPS deploy is not live), so no id migration is needed. If a core-mode deployment ever moves to standalone, `scripts/identity/import-core-orgs.ts` would create local orgs and users with the same ids. That is not in scope.

## 5. Security requirements (each has a test)

1. **Passwords.** argon2id (m=19456, t=2, p=1) with `@node-rs/argon2`. Length 12–128. Breached-password rejection through the library plugin or the HIBP k-anonymity range API (`STUDIO_HIBP_CHECK`, fails open with a log line). A password is never logged. Changing the password revokes other sessions.
2. **Rate limits.** Better Auth rate limits backed by Valkey (secondary storage), keyed by the trusted client IP:
   - sign-in: 5/min per IP and 10/hour per email
   - sign-up: 3/min per IP
   - forgot-password and verification resend: 3 per 15 minutes per email and per IP
   - 2FA verify: 5 per 5 minutes per session
   - invite: 20/hour per org
   - Studio's existing Redis limiter covers `/api/studio/*`. The Stripe and Resend webhooks get their own generous per-IP limit.
   - Caddy passes `X-Forwarded-For` only from trusted proxies.
3. **Account enumeration.**
   - Sign-up always answers "check your email". If the address exists, an `accountExists` email goes to the owner instead. The direct `/api/auth/sign-up/email` path is disabled (`disabledPaths`, or a 404 in middleware as a fallback) and sign-up goes through a server action that maps `USER_ALREADY_EXISTS` to the generic response.
   - Forgot-password always answers 200.
   - Sign-in failures use one generic message, with a dummy argon2 verify for unknown emails to even out timing. A test asserts p95 latency parity within a tolerance.
4. **Session fixation and theft.** New token on authentication steps (§2.3), HttpOnly/Secure/SameSite cookies, a revocable session list, idle timeout, and a `newSignIn` alert option.
5. **Email verification.** Required before first sign-in (`requireEmailVerification`). Single-use tokens with a 24-hour life. An email change needs confirmation from the new address and sends a notice to the old one. Invites need a matching verified email.
6. **2FA.** TOTP (RFC 6238, 30 s, ±1 step) with 10 single-use backup codes, stored hashed. The secret is encrypted at rest; if the library does not encrypt it, it is sealed with the existing KMS envelope. 2FA is mandatory for staff. Disabling it needs a TOTP or backup code plus the password.
7. **Stripe webhooks.** Signature verified on the raw body with 300 s tolerance, event id dedupe, re-fetch before acting, no body logging, and never trusting `metadata.organisationId` without matching `billing_customers`.
8. **Resend and Meta webhooks.** Svix signature and timestamp for Resend; `signed_request` HMAC for Meta.
9. **OAuth (Google, Meta, and the existing platforms).**
   - State is random, single use, 10-minute TTL, and bound to the user and org.
   - PKCE S256 wherever the provider supports it (Google yes, X yes, Meta if documented).
   - Redirect URIs are exact matches on `APP_URL`, and the `next` parameter is allowlisted to relative paths (no open redirect).
   - Tokens are sealed with KMS and `appsecret_proof` is sent to Meta.
10. **Authorisation.** Every new route runs through `withStudioRoute` with a capability. Admin routes also call `requirePlatformStaff`. Cross-org access tests cover every new route.
11. **GDPR.**
    - **Account deletion** (`/account/security`, re-authenticate): revoke sessions. If the user is the sole owner of an org with other members, block and ask for an ownership transfer. If the user is the sole member, schedule org deletion: cancel the Stripe subscription immediately (no refund by default), call the existing `purgeOrganisation` (30-day soft grace, then the existing hard-delete job). Soft-delete the user now and delete the user rows (users, auth_accounts, two_factors, sessions, memberships) at grace end. Keep audit rows (ids only), the email suppression hash and Stripe invoices (UK legal retention; the customer is marked `deleted` in metadata).
    - **Organisation deletion** runs the same path from `/settings/organisation`.
    - **Data export:** the existing `/account/export` gains `account` (profile, memberships, sessions metadata, 2FA status but not secrets, notification preferences) and `billing` (subscription history, invoice links) groups in `export/collect.ts`, with `redactSecrets` applied.
12. **Headers.** CSP with a nonce is extended for Stripe Checkout redirects only; there are no embedded Stripe.js iframes because Checkout is hosted. `frame-ancestors 'none'` on auth pages.

## 6. Config, secrets and runbooks

Add to `.env.example` and `deploy/vps/.env.example` (REQUIRED in standalone unless marked optional):

```
STUDIO_MODE=standalone                     # standalone | core
STUDIO_IDENTITY_MODE= STUDIO_AUDIT_SINK= STUDIO_BILLING= STUDIO_BUSINESSES= STUDIO_META_CONNECT=   # optional per-integration overrides
BETTER_AUTH_SECRET=                        # ≥32 random chars; rotate per runbook
BETTER_AUTH_URL=${APP_URL}
GOOGLE_CLIENT_ID= GOOGLE_CLIENT_SECRET=    # optional: Google sign-in hidden when unset
STUDIO_SIGNUPS_ENABLED=true                # false = invite-only
STUDIO_HIBP_CHECK=true
STUDIO_IMPERSONATION_ENABLED=false  STUDIO_IMPERSONATION_WRITE=false
STUDIO_AUDIT_RETENTION_DAYS=730
STRIPE_SECRET_KEY= STRIPE_WEBHOOK_SECRET=
STRIPE_PORTAL_CONFIGURATION_ID=            # optional; created by scripts/billing/portal-config.ts
STUDIO_TRIAL_DAYS=14  STUDIO_BILLING_GRACE_DAYS=7
STUDIO_QUOTA_MODE=enforce                  # standalone default (was warn)
RESEND_API_KEY= RESEND_WEBHOOK_SECRET=
STUDIO_EMAIL_PROVIDER=resend  STUDIO_EMAIL_FROM="PostMind Studio <no-reply@mail.<domain>>"  STUDIO_EMAIL_REPLY_TO=
STUDIO_UNSUBSCRIBE_SECRET=                 # ≥32 chars
META_APP_ID= META_APP_SECRET= META_LOGIN_CONFIG_ID=  META_GRAPH_VERSION=v26.0
STUDIO_SALES_EMAIL= STUDIO_SUPPORT_EMAIL= STUDIO_LEGAL_ENTITY_NAME=
```

- In standalone, POSTMIND_* and ENGAGEMENT_* become OPTIONAL. `src/lib/env.ts` validates the required set by mode at startup, which fails fast.
- Caddy needs no new routes; the webhook paths are ordinary app routes. The webhooks are not behind Cloudflare challenge rules.
- Compose adds no new services: sessions and rate limits use the existing Valkey, and email jobs use the existing worker.

Runbooks:
- New: `runbooks/auth.md` (secret rotation, superadmin bootstrap, lockout and 2FA reset procedure, session revocation), `runbooks/billing-stripe.md` (products, prices and lookup keys, portal script, tax registrations, webhook endpoint and events, test clocks, dunning settings, refunds, price changes without deploy), `runbooks/email-resend.md` (domain DNS: SPF, DKIM, DMARC, return-path; webhook; suppression handling), `runbooks/meta-connect.md` (FLfB configuration, redirect URIs, deauthorise and data-deletion callbacks, app review scopes).
- Updated: `vps-deploy.md` (new env, "the Core team" becomes optional), `notifications-email.md` (Option B chosen), `platform-account-revocation.md` (Studio-owned Meta tokens).
- `CLAUDE.md` gets standalone architecture replacing the "Core handles X" lines. `BACKLOG.md` gets Phase 18 items 18.0–18.E. `integrations/core/README.md` gets a mode note.

## 7. Build tracks

### Track 0: contracts (one PR, about 1 day, lands first)

Owner: the Track A lead. Only this PR touches the shared files: `prisma/schema.prisma` plus its migration, `src/lib/rbac.ts` (new capabilities), `src/lib/tenant.ts` (optional TenantContext fields plus a delegate to IdentityProvider), `src/lib/studio/api/context.ts` (new optional ApiDeps fields), both `.env.example` files, `src/lib/env.ts` (mode-aware required set), all 11 `messages/<locale>.json` (empty new namespaces), and the stub interfaces:
- `src/lib/identity/provider.ts`
- `src/lib/studio/billing/entitlements-reader.ts` (stub returns `{tier:'BASIC', access:'none'}`)
- `src/lib/studio/billing/catalogue.ts` (types plus today's numbers, moved)
- `src/lib/email/auth-mailer.ts` (`sendAuthEmail(template, to, params, locale)`)
- `src/lib/audit-sink.ts`

After this, each track edits only its own files and namespaces.

### Track A: identity foundation (starts first; B–E need its milestone A1)

- **Files:**
  - `src/lib/auth/*` (Better Auth config, argon2, hooks, rate limits)
  - `src/app/api/auth/[...all]/route.ts`, `src/middleware.ts`
  - `src/lib/identity/{standalone,core,index}.ts`, `src/lib/identity/role-capabilities.ts`
  - `src/lib/audit-sink.ts` and its local implementation, the audit retention job `src/lib/studio/queue/workers/audit-retention.ts`
  - `rbac.ts` `requirePlatformStaff` standalone branch
  - `scripts/auth/create-superadmin.ts`
  - `(auth)/*` pages and `src/components/auth/*`
  - `/account/profile`, `/account/security` and `src/components/studio/account/security/*`
  - `api/studio/account/{delete,sessions}`, `api/studio/organisations` (create, switch)
  - namespaces `auth`, `security`
- **Milestones:** A1 (days 1–3): spike, then Better Auth wired, then StandaloneIdentityProvider behind `requireTenantContext`; the whole existing API test suite passes in both modes. A2: auth screens and security page. A3: account deletion and export groups, super-admin CLI, impersonation (flagged off).
- **Tests:**
  - role-map unit tests, including no wildcard for org roles
  - IdentityProvider unit tests: no session gives 401, non-member 403, cross-site cookie POST 403, header org switch only for members, banned user 401, staff without 2FA has no admin capability
  - integration tests for sign-up, verify, sign-in, 2FA, reset and invite
  - enumeration tests (identical responses, timing tolerance)
  - rate-limit tests
  - session rotation and fixation test
  - Playwright E2E: sign-up → verify → onboarding
  - core-mode regression suite unchanged
- **Done when:** every `/api/studio/*` route works under a Better Auth session; core mode is byte-for-byte the old behaviour; `npm test`, `typecheck` and i18n checks are green; coverage on new code is at least 80%.

### Track B: email (Resend), in parallel after Track 0

- **Files:** `src/lib/studio/notifications/{email.ts, resend-sender.ts, unsubscribe.ts}`, `src/emails/*`, `src/lib/email/*` (implements AuthMailer), `src/lib/studio/queue/workers/send-email.ts`, `src/app/api/email/{resend/webhook,unsubscribe}/route.ts`, the `email` namespace, `runbooks/email-resend.md`, `runbooks/notifications-email.md`.
- **Tests:** every template renders in all 11 locales (snapshots plus ICU check, with ar in RTL `dir`); outbox idempotency; retry; webhook signature valid, invalid and stale; bounce and complaint suppression; the preference-lookup filter; unsubscribe token tamper test; transactional mail cannot be unsubscribed.
- **Done when:** A's auth flows send real mail through Resend in staging; notifications with email opt-in are delivered; `pending_setup` is gone in standalone.

### Track C: billing, plans and entitlements (Stripe), in parallel after A1

- **Files:**
  - `src/lib/studio/billing/*` (catalogue, entitlements, stripe client, checkout, portal, webhook handler, top-ups, access gate)
  - `src/app/api/billing/stripe/webhook/route.ts`, `src/app/api/studio/billing/*`
  - refactors of `services/plan-quotas.ts`, `services/tier-gates.ts`, `cost/caps.ts` and `cost/guard.ts` to read their defaults from the catalogue, plus top-up cap headroom
  - `pipeline/music.ts`, `services/voice-profiles.ts` (min tiers from the catalogue)
  - `route.ts` `assertAccess` hook (a single line; the function lives in billing)
  - worker job-start access check (`queue/workers/*` shared guard helper)
  - `/pricing` page, `/settings/billing`, `UpgradeDialog`, admin entitlement overrides API and UI
  - `scripts/billing/{portal-config,seed-stripe-test}.ts`
  - namespaces `pricing`, `billing`, `upgrade`
  - `runbooks/billing-stripe.md`
- **Tests:**
  - `entitlementsFromSubscription` table tests for every status (trialing, active, past_due within and after grace, unpaid, canceled, incomplete, incomplete_expired, paused)
  - webhook signature, dedupe and out-of-order tests
  - Checkout parameter test (tax, trial only once, idempotency key)
  - top-up credit and consumption tests (idempotent per project and month)
  - cap headroom from top-ups
  - access gate allowlist tests; `none` blocks generate and publish
  - Stripe test-mode E2E with test clocks: trial → active → failed payment → grace → read-only → recovered
  - pricing page renders amounts from mocked `prices.list`
  - the existing quota, tier-gate and cost-cap tests still pass
- **Done when:** in staging, a new org can trial, pay, upgrade, downgrade at period end, buy a top-up and get blocked or unblocked correctly; changing a price in Stripe changes the pricing page with no deploy.

### Track D: standalone replacements (Core-free product), in parallel after A1

- **Files:**
  - `src/lib/studio/core/*` local implementations (`local-business-directory.ts`, `local-organisation-directory.ts`, mode wiring in a new `src/lib/studio/core/select.ts`)
  - `services/businesses.ts` (CRUD, `assertBusinessInOrg`), `app/api/studio/businesses/**`
  - `platforms/oauth.ts` (add the meta client), new `platforms/meta-oauth.ts`, `platforms/meta-credentials.ts` (keyed messages)
  - `app/api/meta/{deauthorize,data-deletion}/route.ts`, the Meta data-deletion status page
  - `services/usage-events.ts` / `calendar-shadows.ts` mode switches, `pipeline/create-deps.ts` (Engagement optional wiring)
  - `components/studio/connections/*`, the business picker in the header component
  - namespaces `connections` and `business` (their existing owners' namespaces, extended)
  - `runbooks/meta-connect.md`, `platform-account-revocation.md`
- **Tests:** business CRUD with cross-org isolation; `businessId` validation on writes; Meta OAuth state (replay, expiry, wrong user); code exchange and page listing with a mocked Graph; `appsecret_proof`; deauthorise and data-deletion `signed_request` valid and invalid; local org reconciliation; standalone has no calls to POSTMIND_* (a test with `fetch` spied); core-mode regression.
- **Done when:** in staging with the operator's Meta app, connect Page and IG, publish a Reel, disconnect, and a deauthorise callback revokes the connection; `/businesses` works; no 501 "waiting for Core" remains in standalone.

### Track E: product surfaces and admin (starts after A1; uses C and D APIs through Track 0 contracts)

- **Files:**
  - `(marketing)/*` (landing page, legal pages, `content/legal/en-GB/*.md` placeholders), `src/app/page.tsx`
  - `/welcome` onboarding extension (`components/studio/onboarding/*`)
  - `/settings/{organisation,members,audit}` and their API routes (`api/studio/org/*`, `api/studio/members/*`, `api/studio/audit`)
  - admin tabs Organisations, Users and Subscriptions (`components/studio/admin/{organisations,users,subscriptions}/*`, `api/studio/admin/{organisations,users,subscriptions}/*`, impersonation UI)
  - `AppShell` org switcher, user menu and banners
  - `demo/api/handlers/p18-*.ts`, `demo/tour/*`
  - namespaces `marketing`, `legal`, `orgSettings`, `members`, `adminOrgs`, `adminUsers`, `onboarding`
  - `CLAUDE.md`, `BACKLOG.md`, `runbooks/auth.md`, `vps-deploy.md`
- **Tests:** screens in en-GB, ar and zh-Hans; members and invites flows; last-owner protection; audit page scoping; admin routes need staff plus 2FA; impersonation disabled by default and read-only when on; legal readiness gate; Playwright E2E for the landing → pricing → sign-up → onboarding → first project happy path; demo build.
- **Done when:** a new visitor can go from `/` to a published video with no Core; staff can run the business from the admin console; `check-physical-css --fail` is clean for new files.

**Order:** Track 0 → A1 → {B, C, D, E} in parallel → A2/A3 finish alongside → joint staging gate. The gate is a full E2E in Stripe test mode plus Resend staging plus the live Meta app, followed by the security review (security-reviewer agent on auth, billing and webhooks).

### Operator must provide

1. **Stripe:** live and test secret keys; webhook endpoint `https://<host>/api/billing/stripe/webhook` and its signing secret; 3 products and 6 recurring Prices with the lookup keys above; 5 top-up Prices; Stripe Tax registrations (UK VAT number; EU OSS if applicable); Smart Retries and dunning settings; brand settings for Checkout and the portal.
2. **Resend:** account and API key; sending domain (e.g. `mail.<domain>`) with DNS records (SPF, DKIM, return-path MX, DMARC `p=none` to start, then tighten); webhook endpoint `https://<host>/api/email/resend/webhook` and its secret; from and reply-to addresses.
3. **Google:** an OAuth client (Web) with redirect `https://<host>/api/auth/callback/google` and consent-screen branding. Separate from the YouTube client.
4. **Meta:** App ID and secret; a Facebook Login for Business configuration (its `config_id`) with the permissions in §2.10; valid OAuth redirect `https://<host>/api/studio/platform-connections/oauth-callback`; deauthorise callback `https://<host>/api/meta/deauthorize`; data-deletion callback `https://<host>/api/meta/data-deletion`; confirmation that the approved Advanced Access covers `instagram_content_publish`, `pages_manage_posts` and the insights permissions, and that Business Verification is complete.
5. **Legal:** Terms, Privacy, Cookies, Acceptable Use, DPA and sub-processor list (English at least), legal entity name and address, support and sales emails.
6. **Other:** final prices (or accept §P.2); the first super-admin email; `BETTER_AUTH_SECRET` and `STUDIO_UNSUBSCRIBE_SECRET` generated into `/etc/postmind-studio/*.env`.

## 8. Risks and open questions

**Risks.**
- **Better Auth API drift:** mitigated by pinning the version, the day-1 spike, and our wrapper (`src/lib/auth`) so options live in one file.
- **Meta app scope mismatch:** if the approved app belongs to Core, or lacks publish permissions with Advanced Access, IG and FB publishing is blocked until App Review. The TikTok, YouTube, X and LinkedIn flows are unaffected.
- **Cost exposure from trials:** capped at £15 per trial, cards required, fingerprint dedupe.
- **Webhook loss:** event re-fetch plus a nightly `subscriptions.list` reconcile job.
- **Quota races:** today's checks are advisory. Standalone enforces them, so a Postgres advisory lock per (org, month) is added in `checkGenerateQuota` (Track C).
- **Shared-file conflicts:** solved by Track 0.
- **The VPS 2 GB memory budget:** argon2 at 19 MiB per hash with bursts of sign-ins. Limit concurrent hashes to 4 with a semaphore.

**Open questions**, each with a default so none blocks the build:
1. Trial terms. Default: 14 days, STANDARD, card required.
2. Annual discount. Default: 2 months free on BASIC and STANDARD, 1 month on PLUS.
3. Cancelled-org data retention. Default: read-only for 90 days, then an email, then the existing purge. `STUDIO_CANCELLED_RETENTION_DAYS=90`; `0` disables auto-purge.
4. Tax-exclusive pricing. Default: yes (B2B SMEs).
5. Invite-only launch? Default: open sign-up (`STUDIO_SIGNUPS_ENABLED=true`).
6. Should approval workflows become a STANDARD+ gate (§P.1)? Default: yes, and existing BASIC orgs keep the workflows they already created.

Two items block **launch** only: legal text (§7 item 5) and Meta permission confirmation (§7 item 4).

---

## P. Plans and tiers (built in Track C)

### P.1 Plan catalogue and feature matrix

Everything below is **already gated in code**, cited by file, unless marked **(new)**.

| | BASIC | STANDARD | PLUS | ENTERPRISE |
|---|---|---|---|---|
| Short videos a month (≤30 s) (`plan-quotas.ts`) | 20 | 60 | 150 | Unlimited (fair use), custom |
| Long videos a month (max length) | 0 | 2 × 3 min | 8 × 6 min | Unlimited, custom |
| Platforms (`plan-quotas.ts`) | TikTok + Instagram + 1 more | All 8 | All 8 | All 8 |
| Daily cost cap (`cost/caps.ts`) | £10 | £30 | £75 | £400 (custom) |
| Monthly cost cap | £40 | £150 | £450 | £3,000 (custom) |
| AI clip provider order (`providers/router.ts`) | fal → replicate | luma → runway → kling | veo → runway → luma → kling | same as PLUS |
| Avatar provider order | d-id → heygen | d-id → heygen | heygen → d-id | heygen → d-id |
| Queue priority (`queue/queues.ts`) | normal | normal | high | high |
| Music and SFX (`pipeline/music.ts`, `sfx.ts`, min STANDARD) | – | ✓ | ✓ | ✓ |
| Brand voice clone (`voice-profiles.ts`, min PLUS) | – | – | ✓ | ✓ |
| 4K renders (`render-options.ts`, `render-presets.ts`) | – | – | ✓ | ✓ |
| Image library (`tier-gates.ts`) | Stock only | Stock + site scrape | + AI image generation | + BYOC image generation |
| Generated images per business a month | 20 | 50 | 200 | 1,000 |
| Website scans: businesses | 1 | 3 | 10 | Unlimited |
| Library INSPIRE / TEMPLATE mode | – / – | ✓ / – | ✓ / ✓ | ✓ / ✓ |
| Custom overlay presets and slideshow templates | – | ✓ | ✓ | ✓ |
| BYOC provider keys (`provider-credentials.ts`, `byoc-registry.ts`) | – | – | – | ✓ |
| White-label outputs (`brand-resolve.ts`; staff can grant through org policy) | – | – | – | ✓ |
| DNS domain verification (`scan/domain-verification.ts`) | – | – | – | ✓ |
| Auto-approve (`review-policy.ts`: ENTERPRISE always human-reviewed) | trusted-creator rule | same | same | always review |
| Approval workflows (multi-step) **(new gate `approval.workflows`)** | single approve | ✓ | ✓ | ✓ |
| Seats **(new)** | 2 | 5 | 15 | custom |
| Businesses **(new; matches the scan limit)** | 1 | 3 | 10 | custom |
| Storage **(new, warn-only in Phase 18; sum of `video_assets.fileSizeBytes`)** | 25 GB | 100 GB | 500 GB | custom |
| Top-up packs **(new)** | 10 short | 10 short, 2 long | 10 short, 2 long | custom |
| Trial | – | 14-day trial of this tier | – | – |

**Free tier: not recommended.** Every generation costs real provider money, and a free tier invites abuse. An org without a plan (access `none`) can sign in and set up its organisation, businesses, brand kit and connections, and draft briefs. Generate, publish and scan return 402 `plan_required` and open the upgrade dialog. This matters because `toPlanTier(undefined)` today falls back to BASIC, so without the access gate a signed-up but unpaid org would get free BASIC generation. The access gate closes that.

**Trial:** STANDARD features for 14 days, card required, one per org and per card fingerprint. Trial allowance: 5 short and 1 long video. Trial caps: £10 a day and £15 in total (entitlement overrides with source `trial`).

### P.2 Proposed prices (GBP, excl. VAT; the operator can change them in Stripe with no code change)

Cost model (my estimates; recheck with real `provider_usage` after beta):
- **Stripe fees, worst case:** 3.25% card (international) + 0.7% Billing + 0.5% Tax = 4.45% + 20p per invoice. UK cards are cheaper at 1.5%. Check current rates at stripe.com/gb/pricing.
- **Infrastructure and email per org a month:** BASIC £2, STANDARD £4, PLUS £8. The VPS, R2 storage and egress, and Resend are shared.
- **Typical provider cost per video:** BASIC short £0.90; STANDARD short £1.60, long (3 min) £9; PLUS short £2.40, long (6 min) £18.
- **Typical use** is 50% of the allowance: BASIC 10 × £0.90 = **£9**; STANDARD 30 × £1.60 + 1 × £9 = **£57**; PLUS 75 × £2.40 + 4 × £18 = **£252**.
- **Worst case** is the monthly cost cap. Generation pauses at 100% (`cost/guard.ts`), so provider spend cannot exceed it: **£40 / £150 / £450**.

Gross margin = (price × (1 − 0.0445) − fixed fee − infrastructure − provider cost) / price.

| Tier | Price | Net after fees and infra | GM typical | GM at cap | Cap as % of price |
|---|---|---|---|---|---|
| BASIC monthly | **£59** | 59×0.9555 − 0.20 − 2 = £54.17 | (54.17−9)/59 = **76.6%** | (54.17−40)/59 = **24.0%** | 68% |
| STANDARD monthly | **£209** | 209×0.9555 − 0.20 − 4 = £195.50 | (195.50−57)/209 = **66.3%** | (195.50−150)/209 = **21.8%** | 72% |
| PLUS monthly | **£749** | 749×0.9555 − 0.20 − 8 = £707.47 | (707.47−252)/749 = **60.8%** | (707.47−450)/749 = **34.4%** | 60% |
| BASIC annual (2 months free) | **£590** (£49.17/mo) | £44.96/mo | **73.1%** | **10.1%** | |
| STANDARD annual (2 months free) | **£2,090** (£174.17/mo) | £162.40/mo | **60.5%** | **7.1%** | |
| PLUS annual (1 month free) | **£8,239** (£686.58/mo) | £648.02/mo | **57.7%** (under 60% at 50% use; 60%+ at ≤ 46% use) | **28.0%** | |
| ENTERPRISE | **from £3,950/mo**, contact us | | | ≥ 15% at a custom cap C if price ≥ (C + £40.20) / 0.8055 | |

Every tier and interval is **positive at the cost cap**, and the monthly plans meet the 60–70% typical target. For ENTERPRISE, the admin console computes the minimum price from the custom monthly cap before staff save an override. With the default £3,000 cap the minimum is £3,775, so the list price is "from £3,950". If the operator wants PLUS annual at 60% or more, set it to about £8,780 (about 2% off) or lower the PLUS allowance to 130 shorts and 6 longs.

**Top-up packs** (one-time; each consumed credit raises that month's cost cap by its worst-case allowance, so paid credits are never blocked):

| Pack | Price | Worst-case cost (cap ÷ allowance) | Cap headroom added | Margin at worst case |
|---|---|---|---|---|
| 10 short, BASIC | £29 | 10 × £2.00 | £20 | 26% |
| 10 short, STANDARD | £39 | 10 × £2.50 | £25 | 31% |
| 10 short, PLUS | £49 | 10 × £3.00 | £30 | 34% |
| 2 long, STANDARD | £39 | 2 × £15 | £30 | 18% |
| 2 long, PLUS | £89 | 2 × £30 | £60 | 28% |

Credits are valid for 12 months, used first-in first-out, and only after the plan allowance runs out. BASIC has no long-video pack, because long video is not included.

#### Revised 2026-09-30: lower prices, fewer videos (operator decision; Phase 20.2)

The tables in P.1 and P.2 above are the 2026-09-29 list, kept for history. The operator approved a lower price list on 2026-09-30. The Stripe lookup keys are unchanged; the amounts in Stripe, `REFERENCE_PRICES_PENCE` and the plan limits in `PLAN_CATALOGUE` (`CATALOGUE_VERSION` 2026-09-30) changed. Everything else in P.1 (features, seats, businesses, storage, platforms, providers, trial) is unchanged.

| Tier | Monthly | Annual (10 × monthly) | Short / month (≤ 30 s) | Long / month | Monthly cost cap | Daily cost cap |
|---|---|---|---|---|---|---|
| BASIC | £29 | £290 | 20 | 0 | £20 | £5 |
| STANDARD | £99 | £990 | 40 | 1 × 3 min | £73 | £15 |
| PLUS | £349 | £3,490 | 80 | 4 × 6 min | £264 | £45 |
| ENTERPRISE | from £1,500 (quoted) | – | unlimited (fair use) | unlimited | £1,100 | £150 |

PLUS annual is now 10 × monthly (2 months free) like the other tiers, not "1 month free".

Typical use (50 % of the allowance, same per-video costs as above): BASIC 10 × £0.90 = £9; STANDARD 20 × £1.60 + 0.5 × £9 = £36.50; PLUS 40 × £2.40 + 2 × £18 = £132. Each monthly cap equals or exceeds the whole allowance at typical cost (£18 / £73 / £264), so nobody is paused before using what they paid for.

| Plan | GM typical | GM at cap |
|---|---|---|
| BASIC monthly £29 | 56.9 % | 19.0 % |
| STANDARD monthly £99 | 54.4 % | 17.6 % |
| PLUS monthly £349 | 55.4 % | 17.6 % |
| BASIC annual £290 | 50.0 % | 4.5 % |
| STANDARD annual £990 | 46.4 % | 2.2 % |
| PLUS annual £3,490 | 47.4 % | 2.0 % |
| ENTERPRISE from £1,500 | | 19.5 % at the £1,100 cap; minimum price for that cap £1,416 |

Top-ups: 10 short BASIC £15 (headroom £1.00 per credit, 27.6 % at worst case), 10 short STANDARD £25 (£1.75, 24.8 %), 10 short PLUS £35 (£2.65, 19.3 %), 2 long STANDARD £29 (£10, 25.9 %), 2 long PLUS £55 (£20, 22.5 %).

The monthly plans trade the 60–70 % typical target for lower prices (54–57 %); annual plans are thin at the cap (2–5 %) but positive. The live numbers and guards are in `runbooks/billing-stripe.md` §5 and `catalogue.test.ts`.

### P.3 Entitlements design

- **Single source of truth:** `src/lib/studio/billing/catalogue.ts`, a versioned `PLAN_CATALOGUE` object in code holding every row of P.1 (quotas, caps, gates, min tiers, provider-order label, seats, businesses, storage, packs, display order, Stripe lookup keys).
  - `plan-quotas.ts` (`DEFAULT_TIER_QUOTAS`), `tier-gates.ts` (`TIER_GATES`, `SCANNED_BUSINESS_LIMITS`, `DEFAULT_IMAGE_GENERATION_MONTHLY_CAP`), `cost/caps.ts` (`DEFAULT_ORG_*_CAP_PENCE`), `music.ts`, `voice-profiles.ts`, `render-presets.ts`, `provider-credentials.ts` and `brand-resolve.ts` all read their defaults from it. The existing `STUDIO_*` env overrides keep working, in the order env > catalogue.
  - The pricing page comparison table and the in-app plan page render from the same object, with prices fetched from Stripe.
  - Per-org differences live in `org_entitlements.overrides`: Enterprise custom quotas, seats, businesses and storage. Cost-cap overrides reuse the existing `org_cost_caps` (13.19) rather than duplicating it.
  - `EntitlementsReader.forOrganisation(orgId)` returns the merge `{tier, access, limits}`, cached for 30 s and invalidated by webhooks and admin writes.
- **Resolution** (`entitlementsFromSubscription`):

  | Stripe status | Tier | Access |
  |---|---|---|
  | `trialing` | STANDARD with trial overrides | full |
  | `active` | the tier of the lookup key | full |
  | `past_due`, now < graceUntil (first failure + 7 days) | tier | full, with banner |
  | `past_due` after grace, `unpaid` | tier | read_only |
  | `canceled`, `incomplete_expired`, none | BASIC | none if the org never paid; read_only after a paid period (export and download stay allowed) |
  | `incomplete` | none | none (checkout unfinished) |

  After this, `applyBetaPlan` still raises the tier to PLUS during an active beta. Core mode uses Core's tier with access `full`.
- **Access gate:** `read_only` and `none` block mutations with 402 `billing_required` / `plan_required`, except an allowlist: billing, account, org settings, members, notifications read, export, downloads, delete. Workers check access at job start for generate, render, publish and scan, so already-queued work pauses cleanly. The same pattern as the kill switch.
  - Scheduled publications are **held** (not cancelled) while read-only and resume on payment through the 17.2 re-enqueue job.
- **Upgrade:** immediate, `proration_behavior=always_invoice` (charged now). The new tier applies on `customer.subscription.updated`. Monthly quota counters are not reset; the higher limit simply applies.
- **Downgrade:** at period end (portal setting, or a subscription schedule from our API). Nothing is deleted.
  - Videos over the new limit: the calendar-month counters keep running, so further generations are blocked until reset or top-up.
  - Seats over the limit: existing members stay; new invites are blocked until the count fits.
  - Businesses over the limit: existing ones keep working; creating new ones and scanning new ones is blocked.
  - Features above the new tier (voice clone, 4K, BYOC, white-label, TEMPLATE mode, image generation) stop at their existing gates on the next use. Saved assets are kept.
- **Top-ups:** Checkout `mode=payment`. On a paid webhook, insert `usage_credits`. At generate time, `checkGenerateQuota` consumes one credit when the plan allowance is used up (row in `usage_credit_uses`, idempotent per project and month) and raises that month's cap headroom.
- **Trial end:** `trial_will_end` sends an email 3 days before. The trial converts automatically; a failed first charge follows the dunning path. Cancelling during the trial moves to access `none` at trial end.
- **Failed payment:** first failure, then 7 days of grace with full access plus banner and emails, then read-only until paid. `invoice.paid` restores full access at once.
- **ENTERPRISE:** "Contact us". Staff create the Stripe subscription manually or from a quote, with the ENTERPRISE product carrying `studio_tier=ENTERPRISE`. Custom limits are set in Admin → Organisation → Entitlements (quotas, seats, businesses, storage) and Cost caps (existing), with the minimum-price check. Every change is audited.

### P.4 Plans and tiers UI (all 11 locales)

- **`/pricing`:** 3 tier cards plus Enterprise, a monthly/annual toggle (annual shows the saving), a comparison table built from the catalogue (the P.1 rows, localised labels, ✓/– with accessible text), top-up packs, a trial note, "excl. VAT", and an FAQ.
- **In-app:**
  - `/settings/billing` plan and usage meters, with the "Upgrade" CTA.
  - `UpgradeDialog` on every gate or quota block: 403 `plan_tier` names the required tier and its price and deep-links to Checkout; `quota_exceeded` offers upgrade or top-up; 402 errors offer "Update payment method" (portal).
  - Inline lock badges on gated controls: voice clone, 4K, TEMPLATE mode, image generation, BYOC, custom presets.
- **Admin:** per-organisation plan override (tier, access, custom limits, reason required, expiry optional), the existing beta and cost-cap panels on the same page, and a subscriptions list with MRR.
