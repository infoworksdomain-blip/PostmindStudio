# Content-safety false negative published (priority risk 3)

| | |
| --- | --- |
| **Metric** | Hive scan miss rate from the periodic human audit, plus user and platform reports. |
| **Threshold** | Any true miss. |
| **Escalation** | Trust & Safety on-call (immediately), then Legal and the Founder for severe categories such as child safety. |

## Controls that exist

- Every render passes the quality gate's Hive scan before review (spec 13.2). Renders over 90 s
  use Hive's async API (13.25): the project waits in QUALITY_CHECKING for Hive's callback at
  `POST /api/studio/webhooks/hive?token=…` (per-task token; Hive signs nothing). Fail closed: no
  `STUDIO_PUBLIC_CALLBACK_BASE_URL`, a failed task, or no callback within
  `HIVE_ASYNC_TIMEOUT_MIN` (default 120) blocks the render. Stuck long-form? Check
  `studio.content_safety_tasks` (state, errorReason) and that the public ingress routes
  `/api/studio/webhooks/hive` to Studio.
- 20.6 Hive V3 (self-serve Secret Key: `HIVE_V3_SECRET_KEY`, `HIVE_API_VERSION=v3`) has no async
  API: renders up to 60 s are one synchronous request (every second checked); longer renders are
  checked as `HIVE_V3_MAX_FRAMES` (default 10) evenly spaced still frames, one request each, so
  content between the samples is NOT checked. V3's default limit is about 100 requests a day
  ("developer testing only", docs.thehive.ai/docs/visual-content-moderation): a 429 is logged
  (`content-safety scan rate limited`), the gate job retries and the video stays unpublished; when
  retries run out the run fails with `quality_gate_error`. Use a V2 Enterprise key for volume.
- Block classes are hard-blocked at a score of 0.8 or above, and customers cannot force-approve
  them (spec 13.5).
- Review-class content pauses the run for PostMind Trust & Safety (BACKLOG 13.17): a script-safety
  REVIEW verdict pauses planning before any asset spend, and a review-level Hive class pauses the
  quality gate. Admin Centre → **Safety review** (`GET /api/studio/admin/safety-reviews`) shows
  the flag, a preview or the script; **Allow** (with a note) resumes the run and the video still
  needs a person's approval, **Block** fails the project with the note (the customer sees it).
  Decisions need `studio:admin:moderation` and are audited (`studio.safety_review.decide`).
  Customers can no longer force-approve review-class content.
- Automatic approval (`AUTO_APPROVE`, trusted creators only) never applies to force-approved,
  flagged or script-`WARN` runs — see [review-publish-automation.md](review-publish-automation.md).
- Publishing requires an approved render.
- Languages (15.C5): the Hive scan is **visual** moderation only, so it is language-independent
  but does not read on-screen text or narration in any language. Words (all 11 Studio languages)
  are screened only by the Layer 2 script-safety classifier. Hive OCR Moderation lists all Studio
  languages (https://docs.thehive.ai/docs/ocr-text-recognition-moderation, read 2026-09-28) but
  is not integrated — **GAP** if a miss involves burned-in text or a non-English script.

## Steps

1. **Take down** the post on every platform:
   `POST /api/studio/publications/<id>/takedown`, or use the Takedown action in `/publications`.
   Takedown calls the platform's delete endpoint where the platform supports one. Where it
   doesn't, the error message tells you to remove the post manually in the platform UI.
2. **Freeze** the organisation if the content looks deliberate:
   `{"level":"workspace","target":"<orgId>","enabled":true}`.
3. Preserve the evidence:
   - The render and its assets in S3.
   - The Hive scores in `renders.qualityIssues`.
   - The audit trail.

   Do not delete anything until Legal has cleared it.
4. For a severe category, follow the legal reporting obligations. Legal decides.
5. Root cause:
   - Was the scan skipped or errored? An `error` result can be force-approved, a `block` result
     cannot.
   - Was the threshold too permissive?
   - Was the category not covered? Adjust `SAFETY_*` in `src/lib/studio/pipeline/quality-checks.ts`
     with a test, and deploy.

## Monthly Trust & Safety audit (BACKLOG 14.11)

The metric "Hive scan miss rate" comes from this audit.

- **Sampling (automatic).** The `sample-safety-audit` job runs at 06:00 UTC on the 1st of each
  month (worker scheduler `sample-safety-audit-monthly`). It draws a uniform random sample of
  `STUDIO_SAFETY_AUDIT_SAMPLE` (default 50, max 500) videos **published** the month before into
  `studio.safety_audit_items`. It is idempotent: a re-run only tops the sample up. If it failed
  (log `safety audit sampling failed`), draw it by hand: Admin Centre → **Safety audit** →
  *Draw sample*, or `POST /api/studio/admin/safety-audit/sample { "period": "YYYY-MM" }`.
- **Review (a person, every month).** Admin Centre → **Safety audit** (`GET
  /api/studio/admin/safety-audit?period=YYYY-MM`) lists the sample with a preview and the post
  link. For each video record **Pass** or **Miss** (a miss needs a note saying what was missed:
  it should have been blocked or sent to review). `POST /api/studio/admin/safety-audit/:id/result`,
  capability `studio:admin:moderation`, audited (`studio.safety_audit.record`). A result is
  recorded once (409 afterwards).
- **A miss** notifies PostMind staff at once (notification kind `safety_review`, link to the
  audit tab). Treat it as a true miss: follow **Steps** above for that publication (take down,
  preserve evidence, root cause).
- **Metric.** The tab's summary shows sampled / pending / passed / missed and
  **miss rate = missed ÷ (passed + missed)** for the period. Record it monthly in the T&S log.
  Threshold: any true miss (above). Target: the whole sample reviewed by the 15th.

**GAP (people):** someone in Trust & Safety must own the monthly review; nothing enforces it
beyond the pending count on the tab.
