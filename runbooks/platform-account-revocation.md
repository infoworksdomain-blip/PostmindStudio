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

### Instagram and Facebook (tokens pushed by PostMind Core)

Studio does not run the Meta login. PostMind Core does, and pushes the tokens to Studio the same
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
(+30 days). The call is idempotent; audit `studio.organisation.purge`. Already-published posts
stay on the platforms (Studio can no longer act for the account; takedowns are the customer's).
To undo within the grace period (organisation restored): release the workspace kill switch and
clear `deletedAt` on the projects; channels must be registered again by Core.

## GAPs

- Hard deletion after the 30-day purge grace (rows and S3 objects) is not built. It is
  destructive and should be an operator-run, audited sweep over `studio.organisation_purges`
  past `graceUntil`, dry run first.
- The daily account-status check job is not built.
- No Core-side retry or alert exists yet for failed internal calls. That code is Core's, owned
  by the Core team.
- Reconciliation between Core's Meta channels and Studio's is built (BACKLOG 13.35) but cannot
  run until Core publishes list-channels. The daily `reconcile-channels` job logs "channel
  reconciliation skipped", and `GET /api/studio/admin/channels/reconciliation` answers 501. Until
  then, a missed DELETE leaves a channel active until Meta refuses its token. Once Core ships the
  endpoint:
  - the job disconnects channels Core no longer lists (audit
    `studio.connection.meta_reconcile_disconnect`);
  - it holds a run that would disconnect every channel of an organisation;
  - it reports channels Core must re-register.
