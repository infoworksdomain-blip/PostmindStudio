# Notification email: delivery status and the pending operator decision (BACKLOG 13.33)

| | |
| --- | --- |
| **Metric** | Notifications with `emailStatus = 'pending_setup'` or `'failed'` (`studio.notifications`). |
| **Threshold** | Any `failed` once a sender is live. `pending_setup` is expected until the decision below is made. |
| **Escalation** | On-call engineer, then the Core team (option A) or DevOps (option B). |

## What exists

- Users choose per notification kind: in-app and/or email (notification preferences, 13.24).
- For every notification, the notifier asks the preferences service which users want email for
  that kind. If anyone does, it hands the notification to the email sender and records
  `notifications.emailStatus`:
  - `pending_setup`: no sender is configured, or Core has no email API yet;
  - `sent` or `failed`: once a sender works.
- The bell shows "Email pending setup" on those notifications. Email never blocks the in-app
  notification or the webhook.
- The sender is chosen by `STUDIO_EMAIL_PROVIDER`: unset or `none` means no sender; `core` means
  `CoreEmailSender`. Any other value is a configuration error.

## Decision the operator must make

**A. PostMind Core sends the email (recommended if Core already emails its users).**

- Studio passes the notification and the opted-in user ids.
- Core resolves addresses and owns templates, unsubscribe, bounces and complaints.
- Studio never stores email addresses.
- Needs from Core: an internal endpoint. The proposed contract is in
  `src/lib/studio/notifications/email.ts`: `POST /api/internal/notifications/email`,
  X-Service-Token, idempotent on the notification id.
- Studio work once it exists: replace the NotImplemented body of `CoreEmailSender.send` (about
  0.5 day plus tests). Then set `STUDIO_EMAIL_PROVIDER=core`.

**B. Studio sends the email itself (Resend or Amazon SES).**

Studio would need:

- each user's address, which Core's context endpoint does not carry, so Core must still add a
  lookup;
- a verified sending domain (SPF, DKIM, DMARC);
- its own unsubscribe link (PECR/GDPR) and bounce/complaint handling;
- a new secret: `RESEND_API_KEY`, or SES credentials and a region.

Studio work: an adapter plus webhooks (about 3 days). Until it is chosen, `resend` and `ses` are
refused at startup.

## Steps (today)

1. `pending_setup` rows are expected. Nothing to do until the decision is made.
2. After a sender goes live, investigate `failed` rows in the worker/web logs: search for
   `notification email failed` with the notification id.

**GAP:** email delivery waits for decision A or B above.
