# Sign-in, organisations and staff access (standalone mode)

| | |
| --- | --- |
| **What** | How people sign in to Studio in standalone mode (Phase 18), how organisations, members and roles work, and how PostMind staff run the admin console: secrets, the first super-admin, lockouts, 2FA resets, session revocation, bans and impersonation. |
| **Check** | `/sign-in` loads; a test user can sign in; `/admin` opens only for staff with 2FA; the Admin Centre shows no legal-readiness warning. |
| **Who** | The operator (secrets, the first super-admin), PostMind staff (support actions in `/admin`). |

Plan: `plans/phase-18.md` §2.1–2.6 and §5. Sign-in is **Better Auth 1.7.6** (Track A,
`src/lib/auth/*`); organisation settings, members, the audit log and the admin tabs are Track E.
In `STUDIO_MODE=core` none of this applies: PostMind Core signs people in (see
[vps-deploy.md](vps-deploy.md) and `integrations/core/README.md`).

> Status (2026-09-29): Track A milestone A1 (Better Auth wired, the standalone identity provider)
> is still being built. Sections marked **(Track A)** describe the plan and Track A's confirmed
> contracts; re-check them against `src/lib/auth/*` once A1 is merged.

## How it fits together

- **Sessions (Track A).** Database sessions in `studio.sessions`, cookie `__Secure-studio.session_token`
  (HttpOnly, Secure, SameSite=Lax), 30 days rolling, 14-day idle expiry, a 60-second cookie cache (so a
  revocation takes at most a minute). A new token on sign-in, 2FA completion, and password or email change.
- **Organisations.** A user belongs to one or more organisations (`studio.organisations`,
  `studio.members`). The session has an active organisation; the header switcher changes it
  (`POST /api/auth/organization/set-active`). A signed-in user with **no** organisation gets
  `403 no_organisation` from every Studio API, and `/welcome` starts by creating one
  (`POST /api/studio/organisations`, Track A). With memberships but no active organisation, the
  oldest membership is used.
- **Roles.** `owner`, `admin`, `publisher`, `creator`, `viewer`, mapped to capabilities in
  `src/lib/identity/role-capabilities.ts` (Track A). Owners manage billing and can delete the
  organisation; admins manage members and settings but never owners; publishers approve and
  publish; creators make videos; viewers only watch. No organisation role ever gets `studio:*`.
- **Members and invitations** (`/settings/members`). Invitations carry an email and a role (never
  owner), expire after 7 days and are accepted only by a signed-in user whose **verified** email
  matches. Every write goes through Better Auth's organisation API (seat limit from the plan, last-owner
  protection, the invite email, audit, cache invalidation): `src/lib/studio/services/membership-gateway.ts`.
  Studio checks its own rules first (`members.ts`): the last owner can never leave or be demoted;
  ownership moves only by **transfer** (`/settings/organisation`), where the new owner is promoted
  before the old one becomes admin.
- **Audit log.** Auth, membership, organisation, billing and staff actions go to `studio.audit_log`
  (append-only: a trigger refuses UPDATE / DELETE except in the retention job; 2 years by default,
  `STUDIO_AUDIT_RETENTION_DAYS`). Owners and admins read their organisation's log at `/settings/audit`.

## Secrets

| Key | What | Rotate |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Signs cookies and encrypts the 2FA secrets and backup codes | See below |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional "Continue with Google"; redirect `https://<host>/api/auth/callback/google` | In Google Cloud, then update the env file and redeploy |

Generate with `openssl rand -hex 32` (at least 32 characters; start-up refuses a shorter one).

**Rotating `BETTER_AUTH_SECRET` (Track A):** changing it signs everyone out and makes the stored 2FA
secrets unreadable, so every 2FA user must re-enrol. Only rotate after a suspected leak: announce
it, deploy the new value, then reset 2FA for affected users (below) or ask them to re-enrol.

## The first super-admin (Track A)

There is no seeded password. On the server:

```bash
bash scripts/vps/compose.sh production run --rm ops node --import tsx scripts/auth/create-superadmin.ts --email ops@example.com
```

It creates the user (or promotes an existing one) and emails a set-password link. Sign in, turn on
2FA at `/account/security`: **staff capabilities are granted only while 2FA is on**, so `/admin`
answers "staff only" until then. Further staff roles are changed only through this CLI or by a
superadmin, and are audited (`staff.role_changed`).

## Support procedures (Admin Centre → Users)

Every action asks for a reason and is written to the audit log with the staff member's id. Staff
accounts cannot be banned or have 2FA reset from the console: use the CLI.

| Situation | What to do |
| --- | --- |
| Suspected account takeover | **Sign out everywhere** (deletes all the user's sessions; effective within the 60 s cookie cache). Ask the user to reset their password. |
| Lost authenticator and backup codes | Verify the person out of band (e.g. a reply from the account's email plus a detail only they know). Then **Reset two-step verification**: the TOTP secret and backup codes are removed and their sessions ended; they sign in with the password and re-enrol. |
| Abuse, fraud, chargebacks | **Ban user** (signs them out at once and blocks sign-in). **Lift ban** reverses it. |
| Locked out by too many attempts | Better Auth rate limits and 2FA lockout expire on their own; do not raise limits for one user. Per IP: sign-in 5/min, 2FA 5 per 5 minutes. Per account or address (any IP, Phase 19.3): sign-in 10/hour per email, 2FA 5 per 10 minutes per user (Better Auth also locks 2FA for 15 minutes after 10 wrong codes in a row), password-reset and verification-email resend 3 per 15 minutes per email. |
| "Too many invitations" | Invitations (including resends) are limited to 20 an hour per organisation and 30 an hour per inviter across all their organisations (`src/lib/auth/account-rate-limits.ts`). Ask them to wait for the hour to pass. |
| Owner left the company, no other owner | The user cannot be demoted while they are the last owner. Ask them to transfer ownership; if they cannot, a superadmin adds a new owner through the CLI (Track A) and records why. |

## Impersonation (off by default)

`STUDIO_IMPERSONATION_ENABLED=false`. When the operator turns it on:

- only a superadmin with 2FA (`studio:admin:impersonate`) sees **View as this user**;
- a reason is required and the start is audited (`staff.impersonation_started`) before the session exists;
- staff can never impersonate staff, a banned or deleted user, or themselves, and cannot nest sessions;
- the session lasts 30 minutes, shows a red "Staff view" banner, and is **read-only**: every write
  answers 403 `impersonation_read_only` (enforced by the identity provider and again in
  `withStudioRoute`) unless `STUDIO_IMPERSONATION_WRITE=true`;
- the organisation's audit log marks each row made during it with "Staff view".

Turn it off again after the support case.

## Legal readiness and opening sign-up

`STUDIO_SIGNUPS_ENABLED=true` (default) opens public sign-up, but in production it stays **closed**
while the Terms of Service or Privacy Policy is still the repository placeholder
(`src/lib/legal/readiness.ts`, `signupsOpen()`); the Admin Centre shows which documents are
outstanding. Replace them as in [vps-deploy.md](vps-deploy.md) "Legal documents". `false` keeps
Studio invite-only.
