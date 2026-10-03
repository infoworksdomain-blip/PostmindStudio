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
  20.12: "platforms" are the formats rendered; "accounts" are the connected social accounts
  posted to. `POST /projects` with `AUTO_ON_APPROVAL` or `SCHEDULED` and no target is refused
  with `400 auto_publish_account_required`; a target whose connection is not this
  organisation's (or not that platform's) with `400 auto_publish_account_unavailable` (both
  translated in `errors.codes.*`). Slideshows and uploads take the same targets and schedule as
  videos. On Create, "Post to" sits in the main form: with no connected account it says the work
  is saved for review (auto-publish and the schedule are off), otherwise each chosen platform
  with an account gets a picker (pre-selected when the business has exactly one account there).
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
4. **Auto-publish failed for a target:** targets go through the auto-publish outbox (BACKLOG
   13.21): rows are written in the approval transaction and sent by the approving request, then by
   the `dispatch-auto-publish` job every minute. Retryable failures (e.g. the connection needs
   reconnecting) retry after 1 min, 5 min, 25 min and 2 h; after 5 attempts the row is FAILED and
   the creator is notified. `GET /api/studio/projects/<id>/auto-publish` shows each target's state,
   attempts and last error (the Review screen's "Auto-publish status"). Fix the cause, then
   **Retry auto-publish** on the Review screen (`POST /projects/<id>/auto-publish/retry`, re-arms the
   FAILED rows). Rows stuck `SENDING` for over 10 minutes (a sender died) are re-claimed; a target
   that was in fact already published is recognised by the duplicate guard and marked SENT.
5. **Scheduled and drip publishing (15.A5):** a project with `publishPolicy: SCHEDULED` writes
   its outbox rows at approval with an absolute `scheduledFor`: `scheduledStartAt` (or now, if it
   has passed) for the first target and `STUDIO_DEFAULT_STAGGER_MINUTES` (15–60, default 30) more
   for each next one. Without a start time the business's drip queue
   (`GET|PUT /api/studio/businesses/<id>/drip-queue`, calendar → Drip queue) gives the next free
   weekly slot (`auto_publish_outbox.slotAt`) within 8 weeks (`DRIP_HORIZON_DAYS` = 56; a test
   keeps it at least 31 so a month ahead can always fill). Rows then behave like step 4; the
   publications they create are ordinary scheduled publications (move or cancel them in the
   calendar). `scheduledStartAt` may be at most 180 days ahead (the same rule as publications;
   400 otherwise).
   - **Month-ahead planning (20.3):** the calendar's drip queue panel has one-click posting plans
     ("3 a week", "5 a week", "Every day": weekdays 12:30, weekends 09:00 in the queue's time
     zone) that fill the slots before saving; onboarding's last step offers the same as "Plan your
     month". The calendar shows the queue's open slots (dashed markers) and a "Next 30 days" line
     from `GET /api/studio/businesses/<id>/drip-queue/upcoming?from&to` (≤ 62 days; open slots
     only within the 8-week horizon). The Create screen's "No date — use the next free drip-queue
     slot" option sends `publishPolicy: SCHEDULED` without a start time.
   - **No free slot (20.3):** when the queue is off, posts to none of the project's platforms, or
     has no free slot within 8 weeks, nothing is scheduled, and that is no longer silent: the
     approval transaction stores `metadata.scheduleIssue { reason: queue_off |
     no_matching_platform | no_free_slot, horizonDays, at }`, the audit log gets
     `studio.project.schedule_unassigned`, the creator gets an `auto_publish_failed` notification
     (message `scheduleQueueOff` / `scheduleNoPlatform` / `scheduleNoFreeSlot`), and the Review
     screen shows the reason with **Open the calendar** and **Try again**. Try again
     (`POST /projects/<id>/auto-publish/retry`) plans the latest approval again against the
     current queue (`{ scheduled, unscheduled }`); picking a date on the Publish tab always works.
6. **YouTube quota reached (15.A9):** the publication goes back to `SCHEDULED` with
   `errorCode quota_exceeded` and `metadata.quotaDeferredUntil` (5 min after the next midnight
   Pacific Time) and is retried then; audit `studio.publication.quota_deferred`. Repeated deferrals
   (`metadata.quotaDeferrals`) mean the daily quota is too small: raise it with Google or cancel
   and reschedule.
7. **TikTok "sent to inbox" (15.A2):** when the connection lacks `video.publish` (or the creator
   cannot direct-post), the video goes to the creator's TikTok inbox and the publication is
   PUBLISHED with `metadata.tiktokMode = "inbox"`. The creator must finish the post in the TikTok
   app and keep the AI-generated label on. Reconnecting TikTok with Direct Post approval restores
   direct posting.
8. **Organisation policy (13.18):** Admin Centre → **Organisations** → Review policy sets, per
   organisation, the default review policy for new projects, whether automatic approval is
   allowed at all, and its own trust threshold (instead of `STUDIO_AUTO_APPROVE_TRUST_THRESHOLD`).
   "Needs review: your organisation's policy turns automatic approval off" means the org has it
   off.

9. **Plan my month (20.9):** `/plans/new` (Create, the calendar header and the end of onboarding
   link to it). The owner picks the window (default the next free day, 30 days, at most 31),
   1–4 posts a day or "use my posting times" (the drip-queue slots in the window, at most 4 a
   day), the video / slideshow slider (default 50/50) and one connected account per platform
   that has one (20.12: a platform without an account is still made but not posted; a plan with
   no account at all makes every post with `REQUIRE_APPROVAL`, `MANUAL`, no time and
   `preApproved: false`, so the posts wait in review and nothing is scheduled — the form and the
   "Generate and schedule" confirmation say so first).
   `POST /api/studio/content-plans` lays out explicit post times (daily times 12:30; 09:00 +
   17:30; + 12:30; + 20:00 in the plan's time zone), skips times other videos hold and times under
   2 hours away, builds a varied mix (how-to, product feature, behind the scenes, offer,
   "why customers choose you", one seasonal post per UK calendar day) and caps the count at the
   remaining monthly allowance **including unused top-up credits** and at what fits under the
   monthly cost cap at the typical cost per post (`cappedReason` allowance / cost_cap; the
   screens offer a top-up). Claude writes the topics in the background (`draft-content-plan`
   job, 20 slots per call, prompt in `prompts/month-plan.md`: business facts from the website
   scan and brand kit, style memory, recent posts to avoid, never invented prices, offers, quotes
   or claims). Ten drafts per organisation per 24 h; 60 "new topic" calls per plan.
   - **Generate and schedule** (`POST …/:id/generate`, needs `studio:project:approve` and
     `studio:publication:write`) creates one project per post through the normal create path —
     videos as 15-second BRIEF projects, slideshows as text-card SLIDESHOW projects — with
     `reviewPolicy AUTO_APPROVE`, `publishPolicy SCHEDULED` at the post's own time and the plan's
     targets, and reserves the allowance for each (`metadata.quotaSlot`, top-up credits used
     first-in first-out). The first post the allowance cannot cover stops the run: it and every
     later post are `SKIPPED` (reason `allowance`). `metadata.contentPlan.preApproved` is the
     owner's approval of the plan: it waives **only** the trust threshold; a flagged content-safety
     scan (none runs today: 20.21, "Not scanned" does not hold a post), script safety, quality
     checks, ENTERPRISE and the organisation's policy still send a post to a person
     (it shows as "Needs your review" or "Held by the safety check" and is never published).
   - **The runner** (`advance-content-plans`, every minute on studio-orchestration, kicked after
     generate) starts at most `STUDIO_CONTENT_PLAN_CONCURRENCY` (default 2) posts per plan at a
     time as low-priority batch jobs, earliest first, and at most `STUDIO_CONTENT_PLAN_DAILY_STARTS`
     posts per UTC day across the platform (default unlimited).
     It holds a plan (`holdReason`) while the organisation is kill-switched, cost-capped or the
     daily limit is reached, and carries on by itself; a queued post whose time is under 45
     minutes away is skipped and its allowance given back. When every post is settled the plan
     is `SCHEDULED` and **one** `monthPlanned` email goes to whoever pressed generate.
   - **Review window:** until its time the owner can open a post (edit it like any project), swap
     it for another topic (`PATCH …/items/:itemId`: the old project is taken out of the schedule and
     a new one made at the same time) or remove it (`DELETE`: generation cancelled, scheduled
     publication cancelled, pending outbox rows dropped, `publishPolicy` back to MANUAL, the time
     freed). **Cancel plan** does that for every post not yet out.
   - **Costs and limits to watch:** a 30-day plan at 4 a day is up to 120 posts in one go. Each
     post with 3 platforms is 3 renders; `STUDIO_CONTENT_PLAN_DAILY_STARTS` can cap the platform's
     daily starts if provider limits need it. The organisation's daily cost cap also paces a plan
     (BASIC £5 a day ≈ 3 videos). Plan posts' times count as held drip-queue slots, so the drip
     queue never gives them to another video.
   - **Stop one plan:** `POST /api/studio/content-plans/<id>/cancel` as the organisation, or the
     workspace kill switch (the runner holds; nothing new starts).

## Verification

- `SELECT "resolvedByUserId", count(*) FROM studio.approval_tasks WHERE state='APPROVED' GROUP BY 1`
  — system approvals are visible and separable from human ones.
- Golden journeys `test/golden/automation.test.ts` (GA-01…GA-05) and `test/golden/month-plan.test.ts`
  (20.9: 3 days × 2 posts, mixed, drafted → scheduled → one email → one removed).
- Month plans: `SELECT status, "holdReason", count(*) FROM studio.content_plans GROUP BY 1, 2`;
  items by status: `SELECT status, "statusReason", count(*) FROM studio.content_plan_items GROUP BY 1, 2`.

Approval and auto-publish share one transaction through the outbox (13.21), and the
per-organisation policy exists (13.18).

### Lost publish jobs (17.2)

A publication is committed before its job is enqueued (POST /publications, the outbox sender,
retry). If the process dies in between, or a `fire-scheduled-publication` job marks its schedule
FIRED and dies before handing over, the publication stays SCHEDULED with no job. The
`redrive-lost-publications` job (every 10 minutes, studio-publish; services/lost-publications.ts)
finds SCHEDULED publications whose time (scheduledFor, or createdAt for "publish now") and last
update are more than `STUDIO_LOST_PUBLISH_MARGIN_MINUTES` (default 15) in the past, and:

- skips them while their own job is still queued (`fire-scheduled__<id>[__<time>]`,
  `publish-video__<id>__<retryCount>`, or the YouTube quota deferral
  `publish-video__<id>__quota__<time>`), while a kill switch (global, workspace, project or the
  platform halt) covers them, when the project is deleted, and when an upload started without
  recording its outcome (check the platform first, as for any `outcome_unknown`);
- otherwise marks a still-PENDING schedule FIRED (so a late fire job is a no-op) and enqueues
  `publish-video` once under `publish-video__<id>__redrive__<retryCount>__<due ms>`. The id is
  deterministic, so two sweeps add it once, and a re-drive that already ran is not repeated
  ("already re-driven once; check it by hand"). publish-video's own SCHEDULED → PUBLISHING claim
  and upload marker still guarantee a single post.

Each re-drive is audited (`studio.publication.lost_job_redriven`, actor
`system:publish-redrive`) and logged ("lost publish job re-driven", with publicationId, platform,
dueAt and jobId). Halted publications are picked up by a later run once the switch is released.
Nothing to do by hand unless a run reports "already re-driven once": look at the publication and
its job in the queue, then use Publications → Retry.
