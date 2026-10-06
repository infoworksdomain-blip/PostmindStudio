# Phase 22.4 Blitz (swipe review) and 22.5 Automations

Operator direction, 2026-10-05/06: Fastlane's swipe review, built on the live carousels and
slideshows, then "a weekly and monthly auto generation and posting at the lowest cost". The
method follows `plans/research-fastlane-2026-10-05.md` (angles, a suggestion queue of about five,
"Why this content works", remix sources beside the output, content-mix snapshots, campaign
lifecycle, `no_unique_content`, weekly insights).

## Data (expand-only migration `20261010010000_blitz_automations`)

| Table | What |
| --- | --- |
| `content_angles` | Per business: title, description, target audience, weight 0–100, source owner/ai, retired. ≤ 100 live (`MAX_ANGLES`). |
| `content_mix_preferences` | Per business: format weights, remix %, mention-business %, caption-style weights (only built-in preset keys), creator chance, and the bounded swipe nudges (`adjustments`). |
| `blitz_suggestions` | One card: angle, format, copy (title, hook, body, CTA, picture queries, per-platform captions), `whyItWorks`, mention flag, remix library item, preview still, 90-day fingerprint, render project, status RENDERING / READY / KEPT / SKIPPED / FAILED / EXPIRED, skip reason, who decided. |
| `automations` | Per business: cadence, duration, platforms, targets, approval mode, mix snapshot, internal cost ceiling, time zone, language, tier, capability snapshot, current period plan, period index, pause reason, lifecycle timestamps, last insight. |

Plus nullable `content_plans.automationId` and `content_plan_items.format / angleId / fingerprint`.

## Format registry (`src/lib/studio/blitz/formats.ts`)

| Key | Source type | Tier | Cost rank | Default weight | Platforms |
| --- | --- | --- | --- | --- | --- |
| carousel | CAROUSEL | pre-made (our sharp renderer) | 1 | 35 | feed, LinkedIn, TikTok photo (verified domain only) |
| slideshow | SLIDESHOW | pre-made (Shotstack, a few pence) | 2 | 35 | all but YouTube |
| wall_of_text | WALL_OF_TEXT | pre-made | 3 | 15 | all but YouTube |
| hook_demo | HOOK_DEMO | pre-made, needs a demo video | 4 | 15 | all |
| ai_video | BRIEF | preview, generated on keep | 10 | 0 | all |
| ugc | BRIEF + UGC style | preview, generated on keep (2 videos) | 20 | 0 | all |

A format is offered only when its source type exists in the generated Prisma enum **and** its
builder is built in or registered (`registerFormatBuilder`): 22.1's HOOK_DEMO and WALL_OF_TEXT
plug in by adding their enum values and calling `registerFormatBuilder` plus a case in
`blitz/project-body.ts`. Paid formats default to weight 0 and are never nudged above 0.

## Blitz (22.4)

- **Queue**: `refill-blitz-queue` (one job per business per 30 s window, idempotent job id; spend
  job, so billing access and the kill switch are checked at start) keeps `BLITZ_QUEUE_SIZE = 5`
  cards ready or rendering. One Claude call (the router's text_generation route, cost-tracked)
  writes every new card from `prompts/blitz-suggestions.md`: each card arrives with its format
  (mix weights), angle (weights, Claude suggests five starter angles when there are none), hook
  type (rotating the eight research hook types), whether it may name the business (mention %),
  and, for pre-made cards at remix %, a reference-library item licensed for INSPIRE (structure
  and pace only, never words or footage).
- **Dedupe**: title + hook fingerprint vs the business's last 90 days of cards, month-plan and
  automation posts and project names (Jaccard ≥ 0.6 on meaningful words) → FAILED
  `no_unique_content`, never shown.
- **Pre-made vs preview**: carousels and slideshows are created as projects with
  `sourceRef "blitz:<id>"` and generated as low-priority batch runs: the carousel posts are already
  written (no thread call), pictures come from the business library and free stock as today, the
  slideshow's hook and closing slides are large text over a dimmed photo (`content.headline`,
  operator brief: no flat grey poster cards). These projects are hidden from the projects list,
  send no "ready for review" notifications and **do not count against the allowance until kept**
  (`plan-quotas.ts countedIn`). Paid formats are a preview card (hook, script beats, a still from
  the business library) and are only created and generated after a keep, through the same
  allowance check as Create (UGC uses 2; the business's default AI creator from 22.3).
- **Caps**: `BLITZ_DAILY_RENDER_CAP = 20` pre-made renders per business per UTC day and
  `BLITZ_MONTHLY_RENDER_CAP_PENCE = 300` of their tracked cost per month; past either, only preview
  cards are made (if a paid format is on) or the deck says "come back tomorrow".
  `BLITZ_DAILY_SWIPES = 60` per person per day. Cards nobody swipes expire after 14 days.
- **Swipe**: keep reserves the allowance under the locked quota check (403 `quota_exceeded` opens
  the upgrade / pack dialog and the card stays), then: schedule next free slot (default; the drip
  queue's next slot, else 12:00 / 18:00 Europe/London skipping held times), post now, or edit
  first (opens the project). Targets are the business's connected accounts inside the channel
  limit, on the destination that suits the format; none → "kept, connect an account". Scheduling
  and posting need approve + publication rights (writers can keep and edit). Skip archives the
  render; a reason nudges the mix (bounded ±20 from the owner's weight) and the toast says what
  changed. Read-only organisations see their deck but nothing new is made (402 on writes).
- **UI**: `/blitz` (nav "Blitz"), card stack with depth, pointer drag with tilt and KEEP / SKIP
  stamps, spring-back, keyboard (→ keep, ← skip, ↑ edit), mirrored in RTL, reduced-motion
  fallback, carousel slides swipeable inside the card, video muted with tap for sound, the remix
  source beside the card (desktop) or in a sheet (mobile). Business → Angles tab: angles and the
  content mix with the learned nudges and a reset.

## Automations (22.5)

- Reuses the month-plan machinery: each period is a `content_plans` row with `automationId`,
  drafted by `draft-content-plan`, generated and posted by `advance-content-plans` (concurrency,
  allowance reservations, explicit post times held from the drip queue, auto-publish through the
  outbox) — no parallel pipeline.
- **Draft**: slots from the cadence (1–3 a day per network, or N a week spread over the week) for
  1 week / 4 weeks / ongoing weekly / ongoing monthly; a format per slot from the mix snapshot,
  spread evenly; when the allowance (units, UGC = 2), the cost cap or the internal ceiling cannot
  cover every slot, the **most expensive slots are dropped first** (`cap_reached`). Each slot's
  angle (title, description, audience) is what the writer is told. Carousel slots skip TikTok
  until the photo domain is verified (`STUDIO_TIKTOK_PHOTO_DOMAIN_VERIFIED`; shown "download
  only"); YouTube gets no slideshows or carousels; a cadence whose networks take no allowed
  format refuses to start (`no_formats`).
- **Lifecycle** (`advance-automations`, every 5 min + kicks): DRAFT → GENERATING → (dedupe:
  rewrite once, else `no_unique_content`) → REVIEW (notification; keep / skip / new topic per slot
  on the detail page or one card at a time in `/blitz?automation=<id>`; nothing is generated or
  charged before approval) → ACTIVE → COMPLETED; "Auto-approve and post" goes straight to ACTIVE.
  PAUSED by the owner (holds new generation: `holdReason paused`), by the allowance at rollover
  (notification + add-videos link), by billing access, or when the person who started it left.
  Ongoing automations draft the next period `AUTOMATION_PERIOD_LEAD_DAYS = 3` before the current
  one ends, re-snapshotting the mix (so swipes and "make more like this" carry over).
- **Insight**: weekly, the period's top post by views → in-app card + notification; "Make more
  like this" nudges its format and angle up (bounded).
- **UI**: `/automations` (list), `/automations/new` (channels → cadence → mix → approval →
  summary with posts per period, format split and the lowest-cost note; pence only for staff via
  `useShowCosts`, the estimate route strips it for customers), `/automations/:id` (actions, pause
  reason, insight, slot calendar per period with format, status, reason, download-only networks).

## Decisions

- **Counting**: a pre-made card counts when kept, not when shown (operator brief); the
  generation timestamp of an unkept Blitz render is ignored by the quota count, the reserved slot
  of a kept one counts.
- **Hidden render projects**: `sourceRef "blitz:<id>"` instead of a JSON filter (the list query
  stays index-friendly and NULL-safe).
- **TikTok carousels**: no API tells us whether the slide domain is verified, so it is an operator
  switch; off = TikTok carousel targets are left out and shown "download only" rather than failing.
- **Review in Blitz first** reviews the drafted copy (cheap) rather than rendering a whole period
  that might be skipped: the period renders after approval, inside the plan runner.
- **Pause** stops new generation and rollover; posts already made still go out (cancel removes
  them).
- **Shotstack HtmlAsset**: the headline shade uses the asset `background` in Shotstack's
  alpha-first hex (`#80000000`, Edit API HtmlAsset reference read 2026-10-06); no CSS line-height
  is set (PR #109).

## Not done / follow-ups

- Caption-style weights are stored and validated against the built-in presets but only the
  existing per-format defaults are applied (no per-post caption style picking yet).
- Creator chance is stored; UGC cards use the business's default creator (22.3) rather than a
  per-card chance.
- No live renders were run: everything is verified with unit, Postgres (PGlite) and component
  tests; the first real Blitz deck and automation period should be checked on staging.
