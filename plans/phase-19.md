# Phase 19: launch preparation

Operator instruction (2026-09-29): "complete all activities that do not require a dependency on me
or server readiness". Studio is the standalone SaaS of Phase 18, hosted on one Hetzner VPS
(runbooks/vps-deploy.md) with Cloudflare R2 EU buckets, AWS KMS, Stripe, Resend, Google sign-in and
its own Meta app. The operator is not technical: every guide is click-by-click, in plain English,
with official documentation cited with read dates.

Three tracks run in parallel, each on its own branch from `main`, merged by the lead.

| Item | Track | Branch | What |
| --- | --- | --- | --- |
| 19.1 | Track 1 | own branch | Corpus tooling for the 50k reference library (`eu-corpus-source` bucket). |
| 19.2 | Track 2 | `p19-golive` | Go-live guide and settings checker (below). |
| 19.3 | Track 3 | own branch | Security hardening. |
| 19.4 | Track 3 | own branch | Dependency and CI upkeep. |
| 19.5 | Track 2 | `p19-golive` | Cancelled-organisation banner copy (below). |

Track 2 owns this plan and the BACKLOG "Phase 19" section; tracks 1 and 3 add only their own
PROGRESS.md lines under "## Phase 19".

## 19.2 Go-live guide and settings checker

1. `runbooks/go-live.md`: ONE ordered guide from nothing to a live site. It consolidates
   vps-deploy.md, r2-setup.md, billing-stripe.md, email-resend.md, meta-connect.md, auth.md,
   deploy.md and backup-recovery.md without contradicting them, and links to them for depth. Every
   step says where to click, what to copy, which settings line (env var) it goes into, and how to
   check it. UI paths come from the providers' current docs (read 2026-09-29); labels the docs do
   not confirm are marked "may be labelled differently". No secret values, placeholders only.
2. `docs-site/go-live.html`: the same guide as one self-contained page (collapsible sections,
   tickable steps, no external scripts; fonts only), generated from the Markdown by
   `scripts/setup/render-go-live.ts` so the two cannot differ (a test compares them).
3. Settings template and checker (`src/lib/setup/*`, CLIs in `scripts/setup/`):
   - `npm run setup:env -- --env production|staging [--domain host] [--out file] [--force]` writes
     the env file from `deploy/vps/.env.example` (grouped, commented, REQUIRED first) plus
     `<env>.backup.env`. `POSTGRES_PASSWORD`, `METRICS_TOKEN`, `STUDIO_INTERNAL_SERVICE_TOKEN`,
     `BETTER_AUTH_SECRET`, `STUDIO_UNSUBSCRIBE_SECRET` and `PG_BACKUP_CIPHER_PASS` come from
     `crypto.randomBytes`. It also fills the known non-secret values: R2 account id, bucket names,
     Shotstack environment and the staging sizes. The default output is `.secrets/` (git-ignored).
     It refuses to overwrite without `--force`.
   - `npm run setup:check -- <file> [--backup file] [--legal-dir dir]` reports each required key as
     OK / MISSING / WRONG with a reason, plus reminders (CHECK) and legal readiness. It never prints
     a value. Exit 0 = ready.
   - The required list is derived at run time from the REQUIRED section of `deploy/vps/.env.example`
     and `requiredEnvForModes()` (what `assertStartupEnv` enforces), minus the keys compose sets.
     Tests pin it against both, against the code's `requireEnv` scan (test/helpers/required-env.ts)
     and against `scripts/vps/deploy.sh`'s preflight.
   - Decision: a Stripe webhook secret (`whsec_`) carries no test/live marker, so the checker
     cannot prove it matches the key's mode. It fails a live key on staging, flags a test key on
     production as a CHECK reminder, and always reminds that key and webhook secret must come from
     the same mode.

## 19.5 Cancelled-organisation banner

The read-only banner said "Payment is overdue" for every read-only organisation, including one
whose subscription was cancelled. `/me` now returns a distinct banner kind
`{ kind: 'cancelled', deletesAt }` when access is read-only and the latest subscription has ended
(`canceled` / `incomplete_expired`) or none is left. `deletesAt` is the retention clock
(`org_entitlements.overrides.retention.cancelledAt`) plus `STUDIO_CANCELLED_RETENTION_DAYS`
(default 90). It is null when retention is off, the purge has already been requested, or the date
is unknown. Read-only for `unpaid` (payment overdue) keeps the old wording. The copy is in all 11
locales (`shell.banners.cancelled.*`); translations are machine-written and queued in the review
lists.
