# Content-safety false negative published (priority risk 3)

| | |
| --- | --- |
| **Metric** | Safety miss rate from the monthly human audit, plus user and platform reports. |
| **Threshold** | Any true miss. |
| **Escalation** | Trust & Safety on-call (immediately), then Legal and the Founder for severe categories such as child safety. |

## Controls that exist

- **No automated video scan (20.21, operator decision 2026-10-02: Hive removed).** Studio has no
  content-safety provider, so the quality gate records content safety as **Not scanned**
  (`content_safety` check `not_run`, `safetyNotScanned`; project `metadata.contentSafety =
  { state: 'skipped', reason: 'no_provider' }`) and the video goes on to the normal review: the
  creator's approval, or automatic approval where the project's review policy allows it. Staff
  see "Not scanned" in the quality panel; customers see nothing about it. What still screens
  content: the Layer 2 script-safety classifier (before any asset spend), the human review step,
  this runbook's monthly audit, and user and platform reports.
- The scan path is kept generic for a future provider (`content_safety` in
  `src/lib/studio/providers/router.ts` is empty; a new adapter returns `ContentSafetyScan`,
  `providers/content-safety.ts`). With a provider configured, the rules below apply again.
- Block classes are hard-blocked at a score of 0.8 or above, and customers cannot force-approve
  them (spec 13.5).
- Review-class content pauses the run for PostMind Trust & Safety (BACKLOG 13.17): a script-safety
  REVIEW verdict pauses planning before any asset spend, and (with a content-safety provider) a
  review-level class pauses the quality gate. Admin Centre → **Safety review** (`GET /api/studio/admin/safety-reviews`) shows
  the flag, a preview or the script; **Allow** (with a note) resumes the run and the video still
  needs a person's approval, **Block** fails the project with the note (the customer sees it).
  Decisions need `studio:admin:moderation` and are audited (`studio.safety_review.decide`).
  Customers can no longer force-approve review-class content.
- Automatic approval (`AUTO_APPROVE`, trusted creators only) never applies to force-approved,
  flagged or script-`WARN` runs — see [review-publish-automation.md](review-publish-automation.md).
- Publishing requires an approved render.
- Languages (15.C5): words (all 11 Studio languages) are screened only by the Layer 2
  script-safety classifier; nothing reads burned-in text or narration in the rendered video —
  **GAP** if a miss involves burned-in text.

## Steps

1. **Take down** the post on every platform:
   `POST /api/studio/publications/<id>/takedown`, or use the Takedown action in `/publications`.
   Takedown calls the platform's delete endpoint where the platform supports one. Where it
   doesn't, the error message tells you to remove the post manually in the platform UI.
2. **Freeze** the organisation if the content looks deliberate:
   `{"level":"workspace","target":"<orgId>","enabled":true}`.
3. Preserve the evidence:
   - The render and its assets in S3.
   - The quality checks in `renders.qualityIssues` (content safety shows `not_run` today).
   - The audit trail.

   Do not delete anything until Legal has cleared it.
4. For a severe category, follow the legal reporting obligations. Legal decides.
5. Root cause:
   - No video scan runs today (20.21). Was the script-safety verdict wrong, or did a person
     approve it? With a provider configured: was the scan skipped or errored? An `error` result
     can be force-approved, a `block` result cannot.
   - Was the threshold too permissive?
   - Was the category not covered? Adjust `SAFETY_*` in `src/lib/studio/pipeline/quality-checks.ts`
     with a test, and deploy.

## Releasing runs parked by 20.19 (one-off, 20.21)

Before 20.21, a video with no working content-safety provider (Hive's dummy key) paused in
QUALITY_CHECKING behind a Trust & Safety review. After deploying 20.21, release them:

```bash
scripts/vps/compose.sh production run --rm ops node --import tsx scripts/ops/release-safety-holds.ts --dry-run
scripts/vps/compose.sh production run --rm ops node --import tsx scripts/ops/release-safety-holds.ts
```

Only PENDING content reviews whose every flag reads "Scan could not run: no content-safety
provider available" are released (closed by `system:studio-safety`, audited
`studio.safety_review.release`); their renders become "Not scanned" and the quality gate
finishes (review, or auto-approval where allowed). Reviews with a real flag stay in the queue.
The worker also releases such a review on its next quality-gate pass. Safe to re-run.

## Monthly Trust & Safety audit (BACKLOG 14.11)

The metric "safety miss rate" comes from this audit.

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
