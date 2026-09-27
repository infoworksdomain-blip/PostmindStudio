# Review and publish automation (auto-approve, auto-publish, templates)

| | |
| --- | --- |
| **Metric** | `studio.project.auto_approve` audit events per organisation; projects whose `metadata.autoPublishResult.status` is `failed` or `partial`; user reports of a video posted that should have been reviewed. |
| **Threshold** | Any auto-approved video later taken down for content reasons; any organisation with repeated `partial`/`failed` auto-publish results. |
| **Escalation** | Trust & Safety on-call for content; Studio on-call for publishing failures. |

## How it works

- **Review checkpoint (spec 5.9).** A project whose `reviewPolicy` is `AUTO_APPROVE` is approved by
  the system right after the quality gate (actor `system:auto-approve`, one `approval_tasks` row,
  audit `studio.project.auto_approve`) only when **all** of these hold:
  - the creator already has ≥ `STUDIO_AUTO_APPROVE_TRUST_THRESHOLD` (default 10) projects in the
    organisation that a **person** approved — automatic approvals never count;
  - the organisation's plan tier is not `ENTERPRISE` ("require review for enterprise");
  - every render passed the gate outright: no force-approve, no failed check, the content-safety
    scan ran and was clean, and the script-safety verdict was `ALLOW` (`WARN` and `REVIEW` go to a
    person). Checks recorded as `not_run` (features not built yet) do not block — they never
    claim to have passed and a human reviewer sees the same list.
  Otherwise the project stays `READY_FOR_REVIEW` and `metadata.review.reason` says why ("Needs
  review: first 10 videos — 3 of 10 approved by a person so far"). An invalid threshold value
  disables auto-approval (reason code `config_invalid`); it never widens it.
- **REQUIRE_APPROVAL_FROM_ROLE.** The approver needs `studio:project:approve` **and** the
  organisation membership role `owner` or `admin` from PostMind Core (403 otherwise).
- **Auto-publish (`publishPolicy` `AUTO_ON_APPROVAL`).** On approval — by a person or the system —
  each target in `metadata.autoPublish.targets` becomes a publication through the same service as
  `POST /publications` (validation, render quality, platform format rules, connection state,
  duplicate guard), acting as `system:auto-publish`. Targets are independent: each outcome is in
  `metadata.autoPublishResult.results[]`, shown on the Review screen. Setting or re-arming targets
  needs `studio:publication:write`. The per-platform kill switch still applies at publish time.
- **Templates (spec 8.6).** `GET|POST /api/studio/templates`, `GET|DELETE /api/studio/templates/:id`.
  Built-ins (`organisationId` null) are read-only; the seed adds "Introduce yourself and what you
  do" (spec 14.5). A `TEMPLATE` project takes the template's formats, publish defaults
  (`templates.publishDefaults`) and shot blueprint, which constrains Layer 2 exactly like a
  library TEMPLATE reference.

## Steps

1. **Stop automatic approval for one organisation now:** there is no per-organisation switch.
   Set the organisation's projects back to review with SQL
   (`UPDATE studio.video_projects SET "reviewPolicy"='REQUIRE_APPROVAL' WHERE "organisationId"='<org>' AND state IN ('DRAFT','READY_FOR_REVIEW')`)
   and, for everything already approved, freeze the workspace
   (`{"level":"workspace","target":"<orgId>","enabled":true}`) or halt the platform.
2. **Stop it everywhere:** set `STUDIO_AUTO_APPROVE_TRUST_THRESHOLD=1000` and redeploy (only
   creators with 1000 human-approved videos qualify). An unparseable value also disables it.
3. **A video was auto-approved that should not have been:** take it down
   (`POST /api/studio/publications/<id>/takedown`), then follow
   [content-safety-miss.md](content-safety-miss.md). The approval row
   (`resolvedByUserId = 'system:auto-approve'`) and `metadata.review` show why it qualified.
4. **Auto-publish failed for a target:** read `metadata.autoPublishResult.results[i].error`
   (the same messages as `POST /publications`: connection needs reconnecting, render doesn't fit
   the platform, already published…). Fix the cause and publish from the Review screen; auto-publish
   does not retry by itself.

## Verification

- `SELECT "resolvedByUserId", count(*) FROM studio.approval_tasks WHERE state='APPROVED' GROUP BY 1`
  — system approvals are visible and separable from human ones.
- Golden journeys `test/golden/automation.test.ts` (GA-01…GA-05).

**GAP:** approval and auto-publish are two steps without an outbox: if the process dies between
them, the project is `APPROVED` with no `autoPublishResult` and nothing is posted — publish it
from the Review screen. **GAP:** no per-organisation auto-approve policy in the Admin Centre
(the spec's "per-org policy" is the project's `reviewPolicy`, set at creation or by a template).
