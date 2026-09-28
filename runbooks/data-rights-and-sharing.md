# Data rights, retention, sharing and Core contracts (Phase 15 track E)

## Data export (15.E1, spec 18.4)

- Users request it at `/account/export`; the `export-account-data` job (analytics queue) writes
  `orgs/<org>/exports/<id>.zip` to the assets bucket. One export at a time per organisation.
- Stuck export (QUEUED/RUNNING for hours): check the job in the dead-letter view; a final failure
  marks the export FAILED and frees the slot. Tokens and secrets are never exported.
- Links last 7 days; the retention sweep deletes the ZIP and marks the export EXPIRED.

## Business purge (15.E2)

- Core calls `POST /api/studio/internal/businesses/:id/purge { organisationId }` on business
  deletion. Effects are immediate (projects soft-deleted and killed, posts cancelled, memories and
  business tokens wiped); rows and files are hard-deleted by the retention sweep after 30 days.
- To cancel within the grace (Core restored the business): delete the `business_purges` row,
  clear `deletedAt` on the projects and unset their `studio.killedProject.<id>` flags. Wiped
  tokens cannot be restored — the business reconnects.

## Retention sweep (15.E8, spec 7.15)

- Daily at 04:30 UTC. Preview with `GET /api/studio/admin/retention` (staff). Each rule deletes
  at most 2,000 rows (200 projects) per run, objects before rows; a failure leaves nothing
  half-deleted and the next run resumes.

## Share links (15.E5, decision P8)

- External reviewers can view and leave feedback, never approve. Revoke a leaked link from the
  review screen (or delete the `share_links` row). Abuse: lower `STUDIO_PUBLIC_RATE_LIMIT_*`.
- `/p/*` and `/api/studio/public/*` must be reachable from the public ingress; responses are
  `no-store`, `noindex`, `no-referrer`.

## Transparency report (15.E4, spec 18.5)

- Staff log every request from policy@postmind.ai and every platform removal notice with
  `POST /api/studio/admin/takedown-requests`, and record the outcome with PATCH. The annual
  numbers come from `GET /api/studio/admin/transparency?year=YYYY`.
- `ops/compliance-matrix.md` is generated: after any `PLATFORM_RULES` or API-version change run
  `npx tsx scripts/ops/compliance-matrix.ts` (CI fails when it is stale).

## PostMind Core / Engagement contracts waiting on the other team (15.W1–W6)

| Item | Studio side | Waits for |
| --- | --- | --- |
| W1 from-content | route answers 501 | Core `GET /api/internal/content/:id` (proposal in core/content-client.ts) |
| W2 usage events | `usage_events` rows stay `pending_setup` | Core `POST /api/internal/usage` |
| W3 calendar | `calendar_shadows` rows stay `pending_setup` | Core calendar entries API |
| W4 org reconciliation | nightly job logs "skipped" | Core `POST /api/internal/organisations/exists` |
| W5 trigger fields | off (`STUDIO_ENGAGEMENT_TRIGGER_FIELDS`) | Engagement ON_VIDEO_PUBLISHED contract |
| W6 Ideogram | adapter never registered | an Ideogram account and key |

When Core ships one of these, implement the client against the published contract, wire it in
(`ApiDeps.core` / `PipelineDeps.core`) and the outbox backlog is sent in order.
