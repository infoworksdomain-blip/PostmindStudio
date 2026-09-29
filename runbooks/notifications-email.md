# Notification email: delivery and status (BACKLOG 13.33, Phase 18 §2.8)

| | |
| --- | --- |
| **Metric** | Notifications with `emailStatus = 'failed'` (`studio.notifications`); `studio.email_outbox` rows in state `failed`. |
| **Threshold** | Any `failed`. `pending_setup` is expected only in core mode (below). |
| **Escalation** | On-call engineer, then DevOps (Resend account, domain, DNS). |

## Decision (operator, 2026-09-29): option B — Studio sends email through Resend

Phase 18 made Studio a standalone product, so option B was chosen: Studio sends notification
email itself through Resend. Option A (PostMind Core sends it) is kept only for core mode.

## How it works

1. Users choose per notification kind: in-app and/or email (notification preferences, 13.24).
2. For every notification the notifier asks the preferences which users want email for that
   kind and hands the notification to the email sender (`STUDIO_EMAIL_PROVIDER`, default
   `resend` in standalone mode).
3. `ResendEmailSender` (`src/lib/studio/notifications/resend-sender.ts`) looks the users up in
   `studio.users` and drops anyone unverified, deleted or banned. Each remaining user gets one
   `studio.email_outbox` row keyed `notification:<notificationId>:<userId>`, so a repeat never
   sends twice. The outbox drops suppressed addresses (hard bounces and complaints).
4. The `send-email` job (queue `studio-email`) renders the email in the user's locale
   (`users.locale`, en-GB fallback) from the keyed message (`notifications.*`, 16.5) and sends it
   with the one-click unsubscribe link and `List-Unsubscribe` / `List-Unsubscribe-Post` headers
   (RFC 8058). The unsubscribe turns email off for that kind only (runbooks/email-resend.md).
5. `notifications.emailStatus`:
   - `sent`: the email was queued in the outbox (delivery is then tracked on the outbox row:
     `sent` → `delivered`, or `bounced` / `complained` / `suppressed` / `failed`);
   - `failed`: queueing failed, or the send job gave up (it sets the notification to `failed`);
   - `pending_setup`: no sender — core mode, where `none` is the default and `core` waits for a
     Core email API (`CoreEmailSender` throws NotImplementedError; proposed contract in
     `src/lib/studio/notifications/email.ts`).
6. The preferences dialog shows the delivery state: `active`, `suppressed` ("we can't email
   you", with a support contact) or `pending_setup`.

Email never blocks the in-app notification or the webhook.

## Steps

1. `failed` notification: find the outbox rows with
   `SELECT id, state, attempts, "lastError" FROM studio.email_outbox WHERE "idempotencyKey" LIKE 'notification:<notificationId>:%';`
   and follow runbooks/email-resend.md ("A send failed").
2. A user says they get no email: check their preference (`notification_preferences.email`),
   that `users.emailVerified` is true, and whether their address is suppressed
   (runbooks/email-resend.md, "Suppression").
3. Core mode: `pending_setup` is expected until Core publishes an email API. Nothing to do.

## Verification

- A test notification for a user with email turned on reaches their inbox in their language,
  and the "Unsubscribe" link turns that kind's email off (the dialog shows it off).
