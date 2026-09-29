# Platform account revocation — Meta, TikTok, YouTube (priority risk 7)

| | |
| --- | --- |
| **Metric** | Platform connection state: `platform_connections.state` = `needs_reconnect` or `revoked`. Publish errors with `errorClass=needs_reconnect`. |
| **Threshold** | Any account in a warning state. For a revocation of **our app**, the threshold is any occurrence. |
| **Escalation** | On-call engineer, then Product. For app-level problems, also the Founder and the platform partner manager. |

## A customer's connection

A refresh failure or a 401 marks the connection `needs_reconnect`. Publishing to it stops with a
clear error, and `/connections` shows a Reconnect button. No operator action is needed beyond
support.

### Daily account-status check (17.3)

The `check-platform-accounts` job (hourly at :20, studio-analytics; services/account-status.ts)
checks each **active** connection at most once per `STUDIO_ACCOUNT_CHECK_INTERVAL_HOURS` (default
24), oldest check first, at most `STUDIO_ACCOUNT_CHECK_BATCH` (default 100) per run and
`STUDIO_ACCOUNT_CHECK_SPACING_MS` (default 2000) apart, so the calls spread over the day. Each
check is the platform's cheap authenticated read, after the usual token refresh: TikTok
`GET /v2/user/info/`, YouTube `channels.list mine=true` (1 quota unit), X `GET /2/users/me`,
LinkedIn `GET /v2/userinfo`, Facebook `GET /{v}/me?fields=id` with the Page token, Instagram
`GET /{v}/{ig-user-id}/content_publishing_limit`. Studio does not call Meta's `debug_token` (it
needs an app access token). With Studio's own Meta login (Phase 18) the Meta probes also carry
`appsecret_proof`.

- An authentication refusal (HTTP 401, a refused refresh, Graph error 190, an expired Meta token)
  marks the connection `needs_reconnect`, notifies its owner in-app ("Reconnect your … account";
  Core-registered Meta channels notify the organisation and point to PostMind settings;
  Studio-connected ones point to the Connections page) once per connection, and writes audit
  `studio.connection.needs_reconnect` (actor `system:account-status-check`). Recovery is the
  usual reconnect.
- Anything else (timeouts, 5xx, 429, an unexpected response) is recorded as
  `statusCheckOutcome = 'unreachable'` and never changes the state; the next day checks again. A
  platform answering 429 is not called again for the rest of that run.
- `platform_connections.statusCheckedAt` / `statusCheckOutcome` hold the last result; the
  Connections page shows "Access checked <date>" after a successful check. Active accounts not
  checked for two days: `SELECT platform, count(*) FROM studio.platform_connections WHERE state =
  'active' AND ("statusCheckedAt" IS NULL OR "statusCheckedAt" < now() - interval '2 days') GROUP
  BY 1` (a growing number means the job is not running or the batch is too small).

### Instagram and Facebook — standalone mode (Studio's own Meta login, Phase 18)

With `STUDIO_META_CONNECT=studio` (the default in `STUDIO_MODE=standalone`) Studio runs Facebook
Login for Business itself and owns the tokens: set-up, callbacks and troubleshooting are in
[meta-connect.md](meta-connect.md). For revocation:

- Studio stores **Page tokens** (from a long-lived user token), which do not expire, so there is
  no refresh job and no Core push. The internal channel routes below answer 404 (no
  `STUDIO_INTERNAL_SERVICE_TOKEN`).
- A token Meta refuses (Graph error 190: password change, app removed, Page role lost) marks the
  connection `needs_reconnect`; the daily account-status check catches it even without a
  publish. The Connections page shows **Reconnect** (runs the Meta login again, which replaces the
  token and re-activates the row) and **Disconnect** (wipes the token).
- The user removing Studio's app on Facebook calls `POST /api/meta/deauthorize`; Studio revokes
  every connection that login created and wipes the tokens (audit
  `studio.connection.meta_deauthorized`). A data-deletion request (`POST /api/meta/data-deletion`)
  does the same and also clears the Meta user id, scopes and account names (audit
  `studio.connection.meta_data_deleted`); the user gets a status link and confirmation code.
- There is no Core channel list, so channel reconciliation does not apply: the daily
  `reconcile-channels` job does nothing and `GET /api/studio/admin/channels/reconciliation`
  answers `{ applicable: false }`.
- **Our Meta app restricted** (App Review, policy strike): every Meta connection fails at once
  with 190 or permission errors. Follow "Our app is restricted or revoked" below with target
  `instagram` and `facebook`; after reinstatement users reconnect from the Connections page.

### Instagram and Facebook — core mode (tokens pushed by PostMind Core)

With `STUDIO_META_CONNECT=core` Studio does not run the Meta login. PostMind Core does, and pushes the tokens to Studio the same
way it does to Engagement (handover 9.5 / 9.6 / 14.13). All three calls carry
`X-Service-Token: <STUDIO_INTERNAL_SERVICE_TOKEN>`:

| Call | When Core makes it |
| --- | --- |
| `POST /api/studio/internal/channels` `{ organisationId, platform: instagram\|facebook, platformAccountId, platformAccountName, accessToken, tokenExpiresAt?, scopes[], businessId?, connectedByUserId? }` | After the user connects (or reconnects) an account. Idempotent upsert; returns `channel.id`. |
| `DELETE /api/studio/internal/channels/:id[?organisationId=]` or `DELETE /api/studio/internal/channels?organisationId=&platform=&platformAccountId=` | The user disconnects the account in PostMind settings. Studio wipes the token. |
| `POST /api/studio/internal/tokens/refreshed` (one channel, or `{ channels: [...≤100] }`) | Core's nightly job refreshed tokens expiring within 7 days. |

- Meta refusing a token (Graph error 190, any subcode) or a token past `tokenExpiresAt` marks
  the channel `needs_reconnect`. Publishing and metrics for it stop with a clear reason. The
  Connections page shows "Needs reconnecting" and points to PostMind settings (there is no
  Reconnect button in Studio).
- Recovery: the user reconnects in PostMind settings, and Core calls `POST /internal/channels`
  again. A successful refresh push also re-activates a `needs_reconnect` channel. A `revoked`
  (disconnected) channel is only reactivated by a new registration: refresh pushes for it return
  409 (single) or `revoked` (batch).
- Then retry the failed publications (Publications → Retry, or the re-drive tool).
- Scopes Core must request, in addition to Engagement's: `instagram_content_publish` and
  `instagram_manage_insights` (Instagram), `pages_manage_posts` and `read_insights` (Facebook).
  Without the insights scopes, publishing works but metrics polling reports the metrics as
  unavailable.
- Symptoms on Core's side: `404` on every internal call means `STUDIO_INTERNAL_SERVICE_TOKEN` is
  unset or shorter than 32 characters in Studio. `401` means the tokens differ. `413` means the
  body is over 64 KB. `429` means Core exceeded `STUDIO_INTERNAL_RATE_LIMIT_PER_MIN`.
- Security: `/api/studio/internal/*` must only be reachable from the private network. Check that
  the ingress denies it publicly. To rotate the token, set the new value in Studio and Core
  together; calls made in between get 401, and Core retries them.

## Our app is restricted or revoked (app review, policy strike)

1. Halt publishing to that platform: Admin Centre → **Kill switch** → *Halt publishing to a
   platform* (or `PUT /api/studio/admin/kill-switch` with `{"level":"platform","target":"tiktok",…}`).
   Uploads stop within 30 s; generation and other platforms continue. Publications that come due
   fail as `kill_switch_platform` with nothing posted.
2. Follow the drafted emergency comms: tell affected customers, and offer render downloads.
3. Work the appeal with the platform's partner contact. Record the timeline.
4. Once access is restored, customers may need to reconnect. Release the platform halt, then
   re-drive the halted publications: `npx tsx scripts/ops/redrive.ts kill_switch --since <halt time>
   --level platform` (review the dry run, then `--apply`), or Admin Centre → **Re-drive**. Each
   publication is retried once; ones whose connection still needs reconnecting fail again with
   `needs_reconnect` and are handled by support.

## Organisation deleted (BACKLOG 13.22)

Core calls `POST /api/studio/internal/organisations/<orgId>/purge` (X-Service-Token), as it calls
Engagement's purge. Studio then, in one transaction: revokes every platform connection of the
organisation and wipes its tokens (Meta channels and Studio's own TikTok / YouTube / X / LinkedIn
connections), engages the workspace kill switch (running work stops), cancels scheduled posts,
soft-deletes projects and style memory, and records `studio.organisation_purges.graceUntil`
(+`STUDIO_PURGE_GRACE_DAYS`, default 30). The call is idempotent; audit `studio.organisation.purge`. Already-published posts
stay on the platforms (Studio can no longer act for the account; takedowns are the customer's).
To undo within the grace period (organisation restored): set the purge row's `state` to
`cancelled` (`UPDATE studio.organisation_purges SET state = 'cancelled' WHERE "organisationId" =
'<orgId>' AND state = 'soft_deleted'`), release the workspace kill switch and clear `deletedAt`
on the projects; channels must be registered again by Core. A later purge call from Core starts a
new grace period.

### Hard deletion after the grace (BACKLOG 14.1)

- The daily `hard-delete-purged-orgs` job (01:30 UTC, studio-orchestration) takes every purge in
  `soft_deleted` or `hard_deleting` whose `graceUntil` has passed. For each: it deletes every
  object under `orgs/<orgId>/` in the configured buckets (`S3_BUCKET_ASSETS`, `_RENDERS`,
  `_THUMBNAILS`, `_LIBRARY`) and any other bucket the organisation's rows name, then the
  organisation's rows in every studio table, children first, 500 rows per batch. Keys outside the
  prefix (shared corpus or stock objects) are counted, never deleted.
- The `organisation_purges` row is kept as the tombstone: `state = 'hard_deleted'`,
  `hardDeletedAt`, and `hardDeleteSummary` (rows per table, objects and bytes per bucket/prefix).
  Audit `studio.organisation.hard_delete` (actor `system:organisation-purge`). The workspace kill
  switch flag is kept, so nothing can run for the organisation. The audit trail is in PostMind's
  audit service and is never touched.
- **Dry run first:** `GET /api/studio/admin/organisations/<orgId>/purge-plan` (staff,
  `studio:admin:moderation`) lists the rows per table and the objects per bucket/prefix that
  would go (object counting stops at 10,000 per bucket: `truncated`), whether the purge is
  `due`, and, after deletion, the tombstone summary.
- **A failed run** leaves `state = 'hard_deleting'` with `hardDeleteError` (typically S3
  `AccessDenied`: the worker role needs `s3:ListBucket` and `s3:DeleteObject` on the buckets).
  Fix the cause; the next daily run resumes (already-deleted rows and objects are simply gone), or
  re-run at once by retrying the failed `hard-delete-purged-orgs` job in the queue.
- Versioned buckets: the delete adds delete markers; the older versions go with the
  noncurrent-version lifecycle rule (30 days, `infra/s3-lifecycle.json`, BACKLOG 14.2). So all of
  an organisation's bytes are gone about 30 days after the hard delete.
- Not covered: a cloned voice at ElevenLabs is not deleted at the provider by the hard delete
  (only Studio's row and consent recording). Delete remaining voices through the voice-profile
  delete flow before the grace ends, or in the ElevenLabs console.

## GAPs

- (Core mode only.) No Core-side retry or alert exists yet for failed internal calls. That code is Core's, owned
  by the Core team. Studio ships the kit for it (BACKLOG 14.10, `integrations/core/`): the
  OpenAPI spec, a copyable client with retries, the retry/alerting recipe
  (`integrations/core/retry-alerting.md`) and a contract suite Core runs against staging
  (`npm run contract:core -- --base-url <staging> --token <token>`).
- (Core mode only; standalone has nothing to reconcile.) Reconciliation between Core's Meta
  channels and Studio's is built (BACKLOG 13.35) but cannot run until Core publishes list-channels. The daily `reconcile-channels` job logs "channel
  reconciliation skipped", and `GET /api/studio/admin/channels/reconciliation` answers 501. Until
  then, a missed DELETE leaves a channel active until Meta refuses its token. Once Core ships the
  endpoint:
  - the job disconnects channels Core no longer lists (audit
    `studio.connection.meta_reconcile_disconnect`);
  - it holds a run that would disconnect every channel of an organisation;
  - it reports channels Core must re-register.
