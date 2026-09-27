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

**GAP:** the monthly audit sampling job and its dashboard are process work for Trust & Safety.
They are not in code.
