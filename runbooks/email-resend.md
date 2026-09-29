# Transactional and notification email through Resend (Phase 18 §2.8)

| | |
| --- | --- |
| **Metric** | `studio.email_outbox` rows by state; `studio.email_suppressions` growth; log lines `email failed`, `resend webhook signature rejected`, `email outbox swept`. |
| **Threshold** | Any `failed` row; more than 2% of a day's sends `bounced`; any `complained` (spam reports hurt the domain's reputation fast); pending rows older than 15 minutes. |
| **Escalation** | On-call engineer, then DevOps (Resend account, DNS). A complaint spike: pause the kind of email causing it and tell the product owner. |

Docs read 2026-09-29 and cited in code: resend.com/docs — send email API, idempotency keys,
errors, add a domain, DMARC, Cloudflare DNS guide, webhooks (verify requests, event types,
email.bounced / email.complained), send test emails; docs.svix.com — manual verification.

## What Studio sends

| Category | Templates | Unsubscribe |
| --- | --- | --- |
| Account security | verifyEmail, resetPassword, passwordChanged, emailChangeConfirm, emailChanged, accountExists, twoFactorChanged, newSignIn | No (service mail) |
| Organisation | invite, ownershipTransferred | No |
| Billing | trialEnding, paymentFailed, paymentActionRequired, subscriptionChanged, subscriptionCanceled, topupReceipt (Stripe sends invoices and receipts itself) | No |
| Account | accountDeletionScheduled, orgDeletionScheduled, dataExportReady | No |
| Notifications | `notification`: every in-app notification kind, for users who turned email on | Yes, one click, per kind |

Wording lives in `messages/<locale>.json` → `email.*` (all 11 locales; en-GB fallback); the
parameters each template needs are in `src/emails/catalogue.ts`. Callers use the `AuthMailer`
contract (`src/lib/email/auth-mailer.ts`, production implementation `src/lib/email/mailer.ts`).

## How it works

1. **Outbox.** Every email is a `studio.email_outbox` row with a unique idempotency key
   (`auth:<verificationId>`, `notification:<notificationId>:<userId>`, …). A repeat with the same
   key is not sent again. A suppressed address is recorded as `suppressed` and not sent.
2. **Job.** The `send-email` job (queue `studio-email`, 5 retries with 5 s → 2 min backoff)
   renders the row in its locale and calls `POST https://api.resend.com/emails` with the row's key
   as `Idempotency-Key` (Resend keeps keys 24 hours), so a retried job never delivers twice.
   429, 5xx and network errors retry; any other error fails the row at once. After a send the
   one-time link (`url`) is removed from the stored params. The kill switch does not stop email.
3. **Sweeper.** Every 5 minutes `sweep-email-outbox` re-enqueues rows whose job was lost
   (`pending` for 5 minutes, `sending` for 15) and deletes finished rows older than 90 days (they
   hold the address).
4. **Webhook.** Resend POSTs delivery events to `/api/email/resend/webhook`, signed with Svix.
   Studio verifies the signature on the raw body (5-minute tolerance) and answers 400 to a bad
   one. `email.delivered` / `email.delivery_delayed` update the row; `email.bounced` (permanent)
   and `email.complained` add the address to `email_suppressions`; `email.suppressed` (Resend's
   own list) and `email.failed` mark the row. Handlers are idempotent, so redeliveries are safe.
   The webhook is rate limited per source address (`STUDIO_WEBHOOK_RATE_LIMIT_PER_MIN`, 600).
5. **Suppression.** Stored as the SHA-256 of the lowercased address, never the address, so it
   survives account deletion. Suppressed users see "we can't email you" in the notification
   preferences; auth screens show the support contact instead (Track A).
6. **Unsubscribe.** Notification mail carries `List-Unsubscribe: <https://…/api/email/unsubscribe?token=…>`
   and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) plus the same link in the
   footer. The token is an HMAC (`STUDIO_UNSUBSCRIBE_SECRET`) over (user, organisation, kind) and
   can only turn email off for that kind. GET shows a confirm page (link scanners change
   nothing); the POST applies it and is audited (`studio.notification_preferences.unsubscribe`).

## Set-up (operator, once per environment)

1. **Resend account and domain.** In Resend → Domains → Add Domain, add a sending subdomain
   such as `mail.<your-domain>` (Resend recommends a subdomain) and pick the region closest to
   most recipients (EU for a UK/EU audience). Then add, exactly as Resend shows them, at your DNS
   host (Cloudflare: **DNS only**, never proxied):
   - `TXT resend._domainkey.mail` — the DKIM public key (`p=…`);
   - `MX send.mail` → `feedback-smtp.<region>.amazonses.com`, priority 10 — the return path
     (bounces come back here);
   - `TXT send.mail` → `v=spf1 include:amazonses.com ~all` — SPF for the return path;
   - after the domain shows **Verified**: `TXT _dmarc.<your-domain>` →
     `v=DMARC1; p=none; rua=mailto:<a mailbox you read>;` to start. After a few weeks of reports
     that show SPF/DKIM passing for all your mail, tighten to `p=quarantine`, then `p=reject`.
   Verification usually takes minutes, up to 72 hours. Leave open/click tracking **off** for this
   domain (it rewrites links in password-reset mail).
2. **API key.** Resend → API Keys → Create: permission **Sending access**, limited to the domain
   above. Put it in `RESEND_API_KEY`.
3. **Sender.** `STUDIO_EMAIL_FROM="PostMind Studio <no-reply@mail.<your-domain>>"` (any address
   on the verified domain). Optional: `STUDIO_EMAIL_REPLY_TO` (a monitored inbox) and
   `STUDIO_SUPPORT_EMAIL` (shown in every footer).
4. **Webhook.** Resend → Webhooks → Add Webhook: endpoint
   `https://<studio-host>/api/email/resend/webhook`, events `email.delivered`,
   `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`,
   `email.suppressed` (others are ignored). Copy the signing secret (`whsec_…`) into
   `RESEND_WEBHOOK_SECRET`. Make sure Cloudflare challenge / bot rules do not apply to
   `/api/email/*`.
5. **Unsubscribe secret.** `openssl rand -base64 48` → `STUDIO_UNSUBSCRIBE_SECRET` (at least 32
   characters). Rotating it invalidates the links in emails already sent (they show "This link
   does not work"; the preferences dialog still works), so rotate only if it leaked.
6. Restart web and worker. In standalone mode the web process refuses to start without
   `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `STUDIO_EMAIL_FROM` and `STUDIO_UNSUBSCRIBE_SECRET`.
   The worker must run the `studio-email` queue (the default queue list includes it).

## Steps

### A send failed (`state = 'failed'`)

1. `SELECT id, template, attempts, "lastError", "updatedAt" FROM studio.email_outbox WHERE state = 'failed' ORDER BY "updatedAt" DESC LIMIT 50;`
2. `lastError` names Resend's error:
   - `validation_error` 403 "domain is not verified" → the domain lost verification (DNS changed):
     re-check the records in Resend → Domains.
   - `restricted_api_key` / `missing_api_key` 401/403 → wrong or revoked key: replace
     `RESEND_API_KEY`, restart.
   - `daily_quota_exceeded` / `monthly_quota_exceeded` 429 → Resend plan limit: upgrade, then
     re-send (step 3).
   - `validation_error` 400/422 → a template bug or a bad address: fix, redeploy.
3. Re-send a row once the cause is fixed: `UPDATE studio.email_outbox SET state = 'pending', attempts = 0 WHERE id = '<id>';`
   The sweeper picks it up within 5 minutes. Re-send auth mail (verification, reset) only if the
   link inside it has not expired; otherwise ask the user to request a new one.

### Rows stuck in `pending`

The worker is not consuming `studio-email` (check `STUDIO_WORKER_QUEUES` and the worker logs)
or Redis is down. Rows are safe; they are sent when the worker comes back.

### Bounces and complaints

- A burst of bounces usually means a bad import or a typo-heavy sign-up source; a complaint means
  someone marked Studio mail as spam. Check which template: `SELECT template, state, count(*) FROM studio.email_outbox WHERE "updatedAt" > now() - interval '1 day' GROUP BY 1, 2;`
- Complaints on `notification` mail: the one-click unsubscribe is working as intended; if one kind
  dominates, discuss its frequency with the product owner.

### Suppression: lift it for a user who fixed their mailbox

1. Confirm with the user (support ticket) that the address works again.
2. In the `ops` shell (vps-deploy.md): `npx tsx scripts/email/unsuppress.ts '<address>'`.
3. Also remove it from Resend's own suppression list (Resend → Suppressions), or Resend keeps
   refusing it (`email.suppressed`).

### Webhook signature rejected

`resend webhook signature rejected` in the logs: the secret was rotated in Resend but not in
`RESEND_WEBHOOK_SECRET` (update and restart; Resend retries failed deliveries), or someone is
probing the endpoint (the rate limit applies).

## Verification

- Staging: send one of each template to `delivered@resend.dev` (Resend's test inbox) and check
  the rows reach `delivered`; send to `bounced@resend.dev` and `complained@resend.dev` and check
  both addresses appear in `studio.email_suppressions` (as hashes) and further mail to them is
  `suppressed`.
- The notification email's "Unsubscribe" link shows the confirm page and, after the click, the
  kind is off in the preferences dialog.
- Gmail / Outlook show a native "Unsubscribe" button on notification mail and none on auth mail.
