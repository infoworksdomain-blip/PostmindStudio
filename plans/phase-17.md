# Phase 17: production hardening

**Scope.** Everything still open that Studio can build without an outside dependency, a person
or staging: the runbook GAPs that are code, and the follow-ups found during Phases 16, R2 and
Render. Items blocked on Core, provider accounts or people stay where they are (the demo's
"not built" register, Phase 13 Wave B, and the Phase 14 items marked "ready to run").

| # | Deliverable | Source | Track |
| --- | --- | --- | --- |
| 17.1 | Sweep abandoned PENDING uploads: DB row and object, after a grace period; never touch READY uploads | runbooks/deploy.md GAP | 1 |
| 17.2 | Re-enqueue SCHEDULED publications whose `publish-video` job was lost (outbox crash between commit and enqueue) | review-publish-automation.md GAP | 1 |
| 17.3 | Daily account-status check per connected platform account: mark it needing reconnection and notify the owner | platform-account-revocation.md GAP | 1 |
| 17.4 | Provider-outage alert rule (circuit open or failover rate) in `ops/prometheus/studio-alerts.yml` | provider-outage.md GAP | 1 |
| 17.5 | Backup copy for object storage (S3 or R2) on a schedule, with a retention bound so purged data ages out; Render cron job | backup-recovery.md GAP | 2 |
| 17.6 | S3 presigned PUT: sign Content-Type and stop sending the empty-body checksum (found in the R2 work) | R2 report | 2 |
| 17.7 | CI: Postgres 17 + pgvector (matches Render), build the Render monitoring image, validate `render.yaml` against Render's published JSON schema | Render report | 2 |
| 17.8 | Scan ownership statement recorded as `{locale, messageKey, text}` and checked against the approved versions | Phase 16 security review | 3 |
| 17.9 | Server-originated text in the reader's language: failure reasons (`errorReason` codes), quality-check details, "Untitled video", every template category | Phase 16 reports | 3 |

**Definition of done** (same as earlier phases): tests for every change, runbooks and PROGRESS
updated, a security review, a green CI, and the GAP lines removed or reworded once closed.
