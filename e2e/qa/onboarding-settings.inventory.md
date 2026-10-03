# QA inventory: Get started, Settings, Account, Export data, sign-in flows

Area owner: QA agent 1. Specs: `e2e/qa/onboarding-settings.*.spec.ts` (helpers in
`onboarding-settings.support.ts`). The CI `e2e` job runs `npx playwright test`, whose `testDir`
is `e2e`, so these files run there without a CI change.

States covered per screen where they exist: empty, loading, error, success, permission-denied
(viewer / publisher / admin), mobile 375 px, dark theme, RTL (`ar`), other locale (`de`).

## Pages (19)

| Route                    | Source                                             | Spec file  |
| ------------------------ | -------------------------------------------------- | ---------- |
| `/sign-up`               | `(auth)/sign-up`, `auth/sign-up-form.tsx`          | auth       |
| `/sign-in`               | `(auth)/sign-in`, `auth/sign-in-form.tsx`          | auth       |
| `/two-factor`            | `(auth)/two-factor`, `auth/two-factor-form.tsx`    | auth       |
| `/verify-email`          | `(auth)/verify-email`, `verify-email-screen.tsx`   | auth       |
| `/forgot-password`       | `(auth)/forgot-password`                           | auth       |
| `/reset-password`        | `(auth)/reset-password`                            | auth       |
| `/invite/[token]`        | `(auth)/invite/[token]`, `invite-screen.tsx`       | auth       |
| `/welcome`               | `(studio)/welcome`, `onboarding/*`                 | welcome    |
| `/settings/organisation` | `settings/organisation-settings.tsx`               | settings   |
| `/settings/members`      | `settings/members-screen.tsx`                      | settings   |
| `/settings/audit`        | `settings/audit-screen.tsx`                        | settings   |
| `/settings/billing`      | `billing/billing-screen.tsx`                       | settings   |
| `/account/profile`       | `account/profile-screen.tsx`                       | account    |
| `/account/security`      | `account/security/*`                               | account    |
| `/account/export`        | `account/export-screen.tsx`                        | account    |
| `/pricing` (plan cards)  | `billing/pricing-screen.tsx` (billing entry point) | settings   |
| 404 / signed-out redirect| `not-found.tsx`, `middleware.ts` page guard        | auth       |
| App shell header         | `app-shell.tsx`, `account-menu.tsx`, language/theme | account    |
| Account banners          | `account/account-banners.tsx`                      | settings   |

## Components, forms and dialogs

Forms (14): sign-up, sign-in, two-factor (TOTP / backup), verify-email resend, forgot-password,
reset-password, organisation create (wizard 1), business create (wizard 2), organisation details,
invite member, change password, change email, profile details, request export.

Wizard steps (6): organisation, business, brand kit, connect, first video, celebrate, plus
finished and "setup skipped" states, step indicator, Back / Skip this step / Continue / Skip setup /
Finish / Resume setup.

Dialogs (7): transfer ownership (password), delete organisation (type name + password), remove
member / leave (confirm), upgrade dialog (plan_tier, quota_exceeded, plan_required,
billing_required), feedback dialog (header), organisation switcher menu, user menu.

Sections of `/account/security` (5): password, two-step verification (enrol, confirm, backup codes,
regenerate, disable), sign-in methods, sessions (list, revoke one, revoke others), delete account.

Billing screen sections (6): plan summary (6 statuses: none, trialing, active, past_due,
read_only, cancelling), plan picker with Monthly/Annual toggle, usage, top-ups, invoices, return
banners (`?checkout=success|cancelled`, `?topup=success|cancelled`).

## API routes exercised (through the UI, plus negative direct calls)

Auth (Better Auth, `/api/auth/*`): sign-up/email, sign-in/email, sign-out, get-session,
verify-email, send-verification-email, request-password-reset, reset-password, change-password,
change-email, update-user, two-factor/enable, verify-totp, verify-backup-code, disable,
generate-backup-codes, list-accounts, organization/get-invitation, accept-invitation.

Studio: `GET/PATCH/DELETE /org`, `POST /org/transfer-ownership`, `POST /organisations`,
`GET /members`, `PATCH/DELETE /members/:id`, `GET/POST /members/invitations`,
`POST /members/invitations/:id/resend`, `DELETE /members/invitations/:id`, `GET /audit`,
`GET /onboarding`, `PATCH /onboarding`, `GET/POST /businesses`, `GET/POST /brand-kits`,
`POST /brand-kits/extract`, `GET /templates`, `POST /projects`, `POST /projects/:id/generate`,
`GET/PUT /businesses/:id/drip-queue`, `GET /billing`, `GET /billing/plans`,
`GET /billing/invoices`, `POST /billing/checkout`, `POST /billing/portal`, `GET /me`,
`GET/DELETE /account/sessions`, `DELETE /account/sessions/:id`, `POST /account/delete`,
`GET/POST /account/export`, `GET /account/export/:id`, `GET /usage`.

## Flows per area

### Sign-up, sign-in, sign-out, reset, verification (auth spec)
- sign-up: validation (password length, email format, name), strength meter, same answer for a new
  and an existing address (no enumeration), `accountExists` email, verification email in the
  outbox, resend, verify link lands signed in on `/welcome`, invalid / reused / expired link.
- sign-in: wrong password and unknown email share one message, unverified address goes to
  verify-email and re-sends, `next` honoured and open redirect refused, per-IP rate limit message.
- sign-out from the user menu, protected pages redirect afterwards, back button.
- forgot / reset: same message for known and unknown address, reset link single-use, short
  password blocked, other sessions revoked, old password dead, new one works, rate limit.
- two-factor sign-in: TOTP, wrong code, backup code (single use), start over, lockout.
- invitations: signed-out invite link, accept as the invited user, wrong user, revoked, expired.

### Welcome wizard (welcome spec)
Organisation (validation, country, language, created owner), business (validation, website
optional, duplicate name, pick existing), brand kit (logo type / size, palette extraction, remove
swatch, font, tone limit 3, save, existing kit), connect (none connected, link, skip), first video
(brief, plan gate dialog, Not now, started state), celebrate (nearly live, posting plan presets,
plan-your-month link), finish, skip setup / resume, progress resumed after reload, Back on every
step, `/welcome?new=organisation`, signed-out redirect, sidebar "Get started" link lifecycle.

### Settings (settings spec)
Organisation (edit, validation, logo https only, read-only for non-managers, transfer ownership
with wrong / right password, delete with name + password), Members (invite each role, duplicate,
invalid, seat limit with and without a plan, resend, revoke, role change, owner protection, remove,
leave, last owner, viewer sees no controls), Audit (events appear, category filter, load more,
empty), Billing (every plan status, picker, annual toggle, checkout and portal redirects with a
mocked Stripe answer, error toast when Stripe is not configured, return banners, non-owner view),
Upgrade dialog (all four codes, Not now, links), account banners.

### Account (account spec)
Profile (name, email language, email change two-step approval, validation), Security (password
change, 2FA enrol / disable / regenerate, sessions list / revoke / revoke others, sign-in methods,
delete account incl. sole-owner block), Export (empty org, request, queued / ready / failed /
expired states, download link, group selection, one-at-a-time, permission).

### Cross-cutting
Language switcher (`ar` RTL, `de`) and theme toggle on the app pages, mobile 375 px overflow on
every page, error detection (banners, page errors, console, 5xx, unexpected 4xx) on every visit.
