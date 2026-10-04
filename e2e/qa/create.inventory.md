# QA inventory: Create (/new and every creation path)

Scope of QA agent 2. Source of truth: `src/app/(studio)/new`, `src/app/(studio)/plans`,
`src/components/studio/create`, `src/components/studio/plans`, the API routes below and their
services. States listed per surface: E empty, L loading, X error, S success, P permission or plan
denied, M mobile 375 px, D dark, R RTL (`ar`).

## Pages

| #   | Route                    | Component                | States covered by `create.spec.ts`   |
| --- | ------------------------ | ------------------------ | ------------------------------------ |
| 1   | `/new`                   | `CreateScreen`           | E L X S P M D R                      |
| 2   | `/new?reference=&mode=`  | `CreateScreen` + banner  | S X (unknown id) P (mode not allowed) |
| 3   | `/plans/new`             | `PlanMonthForm`          | E L X S P M D R                      |
| 4   | `/plans`                 | `PlansList`              | E S X                                |
| 5   | `/plans/[id]`            | `PlanScreen`             | drafting, DRAFT, SCHEDULED, CANCELLED |
| 6   | `/projects/[id]` (after Create) | review screens (other agent owns detail panels; Create only checks the hand-off: draft, generating, billing gate) | S P |
| 7   | `/welcome` step "first video" | onboarding (covered by happy-path/sweep) | P |

## Components

`create/`: `create-screen` (form), `create-options` (PlatformChips, LengthToggle, BrandKitSelect,
AdvancedOptions), `create-planning-options` (LanguageOptions, PlanningAdvancedOptions: tier,
schedule, next-slot, workflow), `auto-publish-option`, `project-template-picker`,
`reference-banner`, `body.ts` (validation, body builders, `parseReference`), `formats.ts`.
Embedded: `TemplatePicker` (slideshow), `VideoUploadField` (upload), `ProfileReviewNotice`.
`plans/`: `plan-month-form`, `plan-editor` (+ `ItemForm`, `AddPost`), `plan-view`, `plan-screen`,
`plans-list`, `plan-parts` (badges, AllowancePanel, CappedNotice, HoldNotice), `plan-model`.
Shell: `UsageBanner`/`UsageMeters` (`usage-meter`), `UpgradeDialog` (`billing/upgrade-dialog`).

## Create form: fields and controls (31)

1. Brief textarea (`#create-brief`, max 4000, autofocus, Ctrl/Cmd+Enter submits)
2. Heading changes with the source (video / slideshow / upload)
3. "Plan my month" link
4. Options toggle (summary line: platforms, length, auto-publish, brand kit)
5. Source radios: Video, Slideshow, Upload (the internal BASIC tier defaults to Slideshow; tier
   names are never shown to customers, 21.5)
6. Slideshow template picker (required for slideshow)
7. Project template picker (video only, hidden with a reference); template replaces platforms/length
8. Platform chips (9 render platforms incl. Instagram and Facebook feed); at least one
9. Length toggle short/long
10. Brand kit select (default pre-selected, "none")
11. Language select (11 locales) and "also make in" chips (max 4, primary excluded)
12. Auto-publish checkbox + one account select per platform (hidden for slideshow)
13. Advanced toggle
14. Audience (500), Call to action (200), both disabled for slideshow
15. Budget in pounds (0..100000), placeholder = server default
16. Approval policy (default / require / auto)
17. Quality tier override (only tiers at or below the plan; disabled for slideshow)
18. Schedule datetime-local (min/max window), "next free slot" checkbox (disabled for slideshow)
19. Approval workflow select
20. Reference banner: INSPIRE/TEMPLATE radios (disabled per allowed modes), clear
21. Upload field (source video), replace label after upload
22. Profile review notice (not for upload)
23. Submit button (Generate / Create slideshow), spinner, disabled while submitting
24. Problem list (`role=alert`): businessRequired, uploadRequired, briefRequired, briefTooLong,
    platformRequired, autoPublishAccountRequired, slideshowTemplateRequired, scheduleInPast,
    scheduleTooFar, scheduleNeedsAutoPublish, budgetRange
25. No-business empty state with link to /business
26. Toasts: slideshowDrafted, generatingScript, generatingUpload, draftNotStarted(error)
27. Redirect to `/projects/:id` after create (even if generate is refused)
28. Upgrade dialog on 402 plan_required / 403 quota_exceeded / 403 plan_tier (21.5: no tier
    names; "Buy a video pack" / "Add a channel")
29. Usage banner (80 % warning, exceeded, enforce)
30. Avatar (HeyGen) presenter: there is **no Create form control**; the presenter is chosen by the
    scripting layer (`AI_AVATAR` visual treatment) and routed to HeyGen/D-ID by the provider
    router. Covered by script/storyboard unit tests; shot-level presenter swap is in project review.
31. Idempotency key on both POSTs (double click must not create two projects)

## Plan my month: fields and controls (24)

Start date, days (1..31), posts a day radios 1-4, "use my posting times" (disabled without
times), video/slideshow mix slider (0-100 step 5), platform chips, account select per platform,
submit "Draft my month", estimate line, allowance panel (limit/pack credits/"buy a video pack"
link to `/settings/billing#topups`; the spend line only for staff, 21.5),
typical cost hint, defaults error with retry, no-business state, problems list (startRequired,
daysRange, platformRequired, accountRequired).
Editor (DRAFT): summary and cost estimate, review window note, capped notice, draft error +
redraft, per item: edit (title, brief, kind, slide hook/points/CTA), move up/down, new topic
(regenerate), remove; add post at time (<= 4 a day), "Generate and schedule" confirm,
"Discard" confirm.
View (GENERATING/SCHEDULED/...): stat tiles, hold notice (kill_switch/cost_cap/daily_limit),
held note, review window, per item: open project, swap (PATCH), remove (confirm), "Cancel plan".

## API routes (Create area)

`POST/GET /api/studio/projects`, `POST /projects/:id/generate`, `GET /usage`,
`GET /templates`, `GET /slideshow-templates`, `GET /brand-kits`, `GET /platform-connections`,
`GET /approval-workflows`, `GET /library/videos/:id`, `POST /uploads`, `POST /uploads/:id/complete`,
`POST /businesses/:id/scan-website`, `GET /scans/:id`,
`GET/POST /content-plans`, `GET /content-plans/defaults`, `GET/ /content-plans/:id`,
`POST /content-plans/:id/{generate,cancel,redraft,reorder}`, `POST /content-plans/:id/items`,
`PATCH/DELETE /content-plans/:id/items/:itemId`, `POST .../items/:itemId/regenerate`.

## Existing automated coverage found (before this QA pass)

Vitest component: `create-screen`, `create-options`, `create-planning`, `create-automation`,
`create-i18n`, `plans.test`, `plan-model.test`, `body.test`, `formats.test`, upgrade-dialog,
usage-meter. API/DB: `test/api/projects.test.ts`, `p20-content-plans.test.ts`,
`p20-schedule-month.test.ts`, `p15-c-planning.test.ts`, billing/quotas. E2E: sweep (opens
`/new`, sources, reference hand-off), happy path (first video, plan gate).

## Not locally verifiable

Real provider output (Claude topic writing, Runway/HeyGen/ElevenLabs renders), BullMQ with the
local Redis 3 (jobs are enqueued but never run; a worker-less run shows the "drafting" state),
Stripe checkout, real S3 upload (presigned PUT is faked), social account OAuth.
