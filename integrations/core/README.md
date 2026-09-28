# Core integration kit — PostMind Studio internal API

For the **PostMind Core team** (BACKLOG 14.10). Studio's service-to-service endpoints are built and
tested; this kit is what Core needs to call them the way it already calls Engagement's
(Engagement handover 9.5, 9.6 and 14.13), and what Studio needs back from Core.

| File | What it is |
| --- | --- |
| [`openapi.json`](openapi.json) | OpenAPI 3.1 spec of every internal endpoint. **Generated** from the zod schemas the route handlers validate with (`src/lib/studio/api/internal-contract.ts`). CI fails if it drifts (`test/integrations/openapi-drift.test.ts`). |
| [`client/studio-internal-client.ts`](client/studio-internal-client.ts) | A dependency-free, typed TypeScript client to **copy into Core**. `fetch`-based, sends `X-Service-Token`, retries 429 / 5xx / network errors with backoff and jitter, honours `Retry-After`. Its types are checked against Studio's schemas in CI (`test/integrations/core-client.test.ts`). |
| `npm run contract:core` | The contract suite Core runs against **Studio staging** (`src/lib/studio/ops/core-contract.ts`, CLI `scripts/core/contract.ts`). |
| [`retry-alerting.md`](retry-alerting.md) | The retry and alerting recipe for Core's side. |

## The endpoints

All under `/api/studio/internal/`, all `X-Service-Token`, all idempotent. See `openapi.json` for
the exact schemas.

| Operation | Call | Core calls it when |
| --- | --- | --- |
| `registerChannel` | `POST /channels` | The user connects or reconnects an Instagram account / Facebook Page (after Core's token exchange). 201 created, 200 updated. |
| `disconnectChannel` | `DELETE /channels/:id[?organisationId=]` | The user disconnects it in PostMind settings (`:id` = `channel.id` from register). |
| `disconnectChannelByAccount` | `DELETE /channels?organisationId&platform&platformAccountId` | Same, when Core did not keep Studio's id. |
| `pushRefreshedTokens` | `POST /tokens/refreshed` | Core's nightly refresh job (one token, or `{ channels: [≤100] }`). |
| `purgeOrganisation` | `POST /organisations/:id/purge` | An organisation is deleted. 202. |

Scopes Core must request in addition to Engagement's: `instagram_content_publish`,
`instagram_manage_insights` (Instagram); `pages_manage_posts`, `read_insights` (Facebook).
See `runbooks/platform-account-revocation.md`.

## Wiring it in Core (the Core team's steps)

1. **Configuration.** Studio operators set `STUDIO_INTERNAL_SERVICE_TOKEN` (≥ 32 random
   characters) on Studio; Core stores the same value as a secret. Core calls Studio over the
   **private** network only; `/api/studio/internal/*` must not be publicly routable.
2. **Copy the client** (`client/studio-internal-client.ts`) into Core. It has no dependencies.
3. **Call it** next to the existing Engagement calls:
   - after the Meta token exchange → `registerChannel`, and store `channel.id`;
   - on disconnect in settings → `disconnectChannel(id)`;
   - in the nightly refresh job → `pushRefreshedTokens(items)`; act on each result
     (`not_found` → call `registerChannel`; `revoked` → the user disconnected it, stop refreshing);
   - on organisation deletion → `purgeOrganisation(orgId)`.
4. **Retry and alert** as in [`retry-alerting.md`](retry-alerting.md): the client retries
   transient failures in-process; anything that still fails goes to Core's durable retry queue
   and alerts.
5. **Run the contract suite against Studio staging** before release, and again after any change
   on either side:

   ```bash
   STUDIO_CONTRACT_BASE_URL=https://<studio-staging-private-host> \
   STUDIO_CONTRACT_TOKEN=<staging STUDIO_INTERNAL_SERVICE_TOKEN> \
   npm run contract:core
   # or: npm run contract:core -- --base-url https://… --token …
   ```

   Run it from a Studio checkout (`npm ci` first) on a host that can reach Studio staging's
   private ingress. It creates a synthetic organisation `contract-core-<time>-<random>` with a
   fake token, exercises every operation (auth, validation, 413, idempotent register, single and
   batch refresh, 404 / 409, both disconnects, purge twice), checks every response against
   `openapi.json`, checks no token is ever echoed, and ends by purging the synthetic organisation
   (its rows remain soft-deleted with tokens wiped). Exit code 0 = all 12 checks passed.
   **Never run it against production.**

## Changing an internal endpoint (Studio side)

Change the route / zod schema, update `src/lib/studio/api/internal-contract.ts` if a response
changed, then regenerate and commit the spec:

```bash
npx tsx scripts/core/generate-openapi.ts
```

Tell the Core team: the spec diff is the change log. The client's hand-written types must be
updated too; `npm run typecheck` fails until they match the schemas.

## What Studio needs from Core

Studio has three open dependencies on Core. None of these endpoints exist in Core today, so Studio
answers an honest `501` (or skips the job) until they do. The contracts below are **Studio's
proposals**, written in Phase 13 (Wave B); the Core team owns the final shape. When Core publishes
one, Studio implements the matching adapter (the interfaces are already in place) and the
register item is closed.

### 1. List an organisation's businesses (BACKLOG 13.34)

Source: `src/lib/studio/core/business-directory.ts` (`CoreBusinessDirectory`). Core's context
endpoint (`GET /api/internal/context/:userId`) carries no businesses, so Studio cannot list or
validate `businessId`.

```
GET {POSTMIND_CORE_URL}/api/internal/organisations/:organisationId/businesses
X-Service-Token: <POSTMIND_SERVICE_TOKEN>
→ 200 { "businesses": [ { "id": "biz_1", "name": "Leeds Sourdough", "domain": "leedssourdough.co.uk" | null } ] }
→ 404 when the organisation is unknown to Core
```

Studio would cache it per organisation for 5 minutes (like the context), serve it from
`GET /api/studio/businesses` and validate `businessId` on writes against it.

### 2. List an organisation's Meta channels (BACKLOG 13.35)

Source: `src/lib/studio/core/channel-directory.ts` (`CoreChannelDirectory`). Core pushes channels
to Studio but publishes no list, so a missed `DELETE` or register cannot be detected. Studio's
daily reconciliation job (`reconcile-channels`) and `GET /api/studio/admin/channels/reconciliation`
are built and wait for this.

```
GET {POSTMIND_CORE_URL}/api/internal/organisations/:organisationId/channels?platform=instagram,facebook
X-Service-Token: <POSTMIND_SERVICE_TOKEN>
→ 200 { "channels": [ { "platform": "instagram", "platformAccountId": "17841400000000000", "platformAccountName": "@leedssourdough" } ] }
→ 404 when the organisation is unknown to Core (treated as "no channels")
```

No tokens in the list: Core keeps pushing them through the internal endpoints above.

### 3. Send email for Studio notifications (BACKLOG 13.33, option A)

Source: `src/lib/studio/notifications/email.ts` (`CoreEmailSender`, `STUDIO_EMAIL_PROVIDER=core`).
Studio knows user ids, not email addresses (the context carries none). Option A is that Core sends
the email (addresses, templates, unsubscribe, bounces); option B (Studio sends via Resend / SES) is
an open operator decision, see `runbooks/notifications-email.md`.

```
POST {POSTMIND_CORE_URL}/api/internal/notifications/email
X-Service-Token: <POSTMIND_SERVICE_TOKEN>
{ "organisationId": "org_1", "userIds": ["user_1"], "subject": "…", "text": "…",
  "link": "https://studio…/projects/…" | null, "idempotencyKey": "<studio notification id>" }
→ 202 { "accepted": 1 }
```

`idempotencyKey` is Studio's notification id: Core should drop a repeat with the same key, since
Studio retries a failed send.
