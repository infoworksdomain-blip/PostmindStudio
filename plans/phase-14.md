# Phase 14 — deliver every outstanding item that isn't blocked by a dependency

**Scope.** This phase covers the "Not built yet" register after Phase 13, minus the items blocked
on an outside dependency.

The register had 18 items. These 7 are excluded, because each waits for something outside
Studio (they stay in the register and in Phase 13 Wave B):

- email delivery
- the business list
- Meta channel reconciliation
- BPM/CLIP/CLAP
- the rest of style memory
- deeper analytics (LinkedIn, TikTok)
- the remaining fallback providers

That leaves **11 deliverables**. For each one, Studio builds everything that can be built in code
(automation, configuration, deployment, integration kits). The last step is marked
**Operator run**, **DevOps** or **Core team** where only a person with that environment or
authority can do it.

| # | Deliverable | Register id | What gets built | Last step, and who does it | Days |
| --- | --- | --- | --- | --- | --- |
| 14.1 | Organisation purge: hard deletion after the 30-day grace | meta-purge | Daily job deletes a purged organisation's rows and S3 objects once `graceUntil` passes, and records the deletion in `organisation_purges`. The grace period follows Engagement 14.13 (30 days), set by `STUDIO_PURGE_GRACE_DAYS`. A dry-run admin endpoint lists what would be deleted. | — (fully built) | 2 |
| 14.2 | S3 lifecycle rules | s3-lifecycle | `infra/s3-lifecycle.json`: intermediates expire after 30 days, noncurrent versions after 30 days, abandoned multipart uploads after 7 days, `library/staging/` after 2 days. `scripts/ops/apply-s3-lifecycle.ts` is dry-run by default, prints a diff, and applies with `--apply`. A CI check validates the JSON. | **DevOps** runs it with production credentials | 1 |
| 14.3 | Prometheus + Alertmanager deployment | alerting-deploy | `docker-compose.monitoring.yml`: Prometheus scrapes web `/api/metrics` and each worker's `:9464/metrics` with the bearer file, loads `ops/prometheus/studio-alerts.yml`, and runs Alertmanager with the PagerDuty and Slack secret files. Includes a smoke script that fires a test alert, and the runbook. | **DevOps** supplies the PagerDuty key and Slack webhook and runs it | 2 |
| 14.4 | Browser-rendering fallback for blocked scans | scan-render-fallback | A headless render service in `docker-compose.prod.yml` behind a profile. Policy: it is used only when the business owner has confirmed they own the site. It is never used to get round a third party's bot protection. The scan UI states this. | **Operator** enables the profile on staging | 0.5 |
| 14.5 | k6 smoke + full run and throughput target | k6 | `scripts/ops/staging-gate.ts --k6`, with thresholds from the spec. Results go into `ops/results/`. A `staging-gate.yml` workflow (manual trigger) runs it against staging using repository secrets. | **Operator run** on staging | 1 |
| 14.6 | Kill-switch and rollback rehearsals | rehearsals | `staging-gate.ts --rehearse`: kill switch at every level (global, workspace, project, provider, platform) with timings against the 60 s target, plus a rollback timer that deploys N+1, rolls back to N and times readiness against the 5 min target. Writes a report. | **Operator run** on staging | 1 |
| 14.7 | Point-in-time restore drill | pitr | `staging-gate.ts --restore-check <DATABASE_URL>`: after a restore, checks migration status, row counts against a snapshot, pgvector, and runs the golden-path smoke against the restored database. Records RTO/RPO. | **DevOps** performs the restore, then runs the check | 1 |
| 14.8 | Live provider and posting runs | live-providers | `npm run gate:live` runs each provider's live test (Runway, Luma, HeyGen, ElevenLabs incl. Music and voice, Shotstack, Hive incl. async, AssemblyAI, OpenAI, Anthropic, Storyblocks) plus one real post and takedown per platform with a test account. Prints a cost estimate first and requires `--confirm`. | **Operator run** with staging keys and test accounts | 2 |
| 14.9 | Corpus sample run and full run | corpus-runs | A manifest template and validator (`corpus/manifest.template.csv`), a pre-flight check (caps tier, worker concurrency, bucket access) in `ingest-corpus.ts --preflight`, and a review checklist. | **Operator run**: sample → review → full | 1 |
| 14.10 | Core wiring for the Meta internal endpoints | core-meta-wiring | A Core integration kit: an OpenAPI spec for Studio's internal endpoints, a typed client module Core can copy, contract tests Core can run against Studio's staging, and a retry/alerting recipe. | **Core team** wires it in | 2 |
| 14.11 | Beta onboarding, on-call rota, Trust & Safety audit | beta | **Beta:** a cohort flag per organisation (Plus for 30 days, spec playbook 10.4), in-app feedback (`POST /api/studio/feedback` + staff list), and a beta dashboard for staff (usage, failures, feedback). **Trust & Safety:** a monthly audit sampling job and staff screen that picks N published videos for human re-check and records results. **On-call:** a rota template and paging escalation config. | **People**: recruit 5–10 customers, staff the rota, run the audits | 4 |

**Total: about 17.5 engineering days**, built as three parallel tracks:

- **Track 1** (data and infrastructure): 14.1, 14.2, 14.3, 14.4
- **Track 2** (staging gate): 14.5, 14.6, 14.7, 14.8, 14.9
- **Track 3** (integrations and beta): 14.10, 14.11

**Definition of done** is the same as Phase 13:

- A contract for every endpoint, with unit and API tests.
- Sample handlers in the demo.
- Runbooks, PROGRESS and BACKLOG updated.
- A security review and green CI.

When an item's last step is a person's, it is marked "ready to run" in the register rather than
removed, and it moves to "done" only once that step has happened.
