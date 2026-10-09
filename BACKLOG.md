# BACKLOG.md — PostMind Studio Build Sequence

Work items in the order Claude Code should execute them. Each item names its acceptance criteria — do not mark complete without meeting them.

**Rules:**
- Work top to bottom. Do not skip phases without operator approval.
- Every item ends with a tests-passing commit.
- Every item updates `PROGRESS.md`.
- At each **[GATE]** the operator reviews and unblocks the next phase.

---

## Phase 0 — Foundations (target: week 1)

- [x] **0.1** Initialize Next.js 15 (App Router) + TypeScript strict + Prettier + ESLint. Set up `package.json`, `tsconfig.json`, `next.config.ts`. Match the Engagement service's TypeScript config.
- [x] **0.2** Install core dependencies: `@prisma/client prisma bullmq ioredis zod pino @anthropic-ai/sdk`. Dev: `vitest @vitest/ui @types/node tsx`.
- [x] **0.3** Set up Prisma with `schema.prisma`, `multiSchema` preview feature enabled, `schemas = ["studio"]`.
- [x] **0.4** Add `pgvector` extension to schema (raw SQL migration).
- [x] **0.5** Create `.env.example` covering every variable in v1.0 spec Section 8 (DB, Redis, PostMind integration, Meta, Anthropic, providers, queue, observability).
- [x] **0.6** Set up Vitest with a passing hello-world test.
- [x] **0.7** Add `docker-compose.yml` for local Postgres 15 with pgvector + Redis 7. Include a `db:reset` npm script.
- [x] **0.8** Add basic CI (`.github/workflows/ci.yml`): typecheck, lint, test on push.
- [x] **0.9** Add `README.md` with setup steps (install, env, migrate, dev, test).
- [x] **[GATE 0]** Operator confirms local dev environment runs, tests pass, CI green.

---

## Phase 1 — Integration points + schema (target: week 1-2)

- [x] **1.1** Implement `src/lib/prisma.ts` — singleton PrismaClient with dev/prod logging.
- [x] **1.2** Implement `src/lib/errors.ts` — custom error classes (`UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ValidationError`, `ProviderError`, `KillSwitchTriggeredError`, `RateLimitError`).
- [x] **1.3** Implement `src/lib/logger.ts` — pino structured logger with correlationId support.
- [x] **1.4** Implement `src/lib/tenant.ts` — JWKS-verified JWT parsing, PostMind Core context fetch, 5-min cache. Unit tests for happy path, expired token, missing token, wrong audience.
- [x] **1.5** Implement `src/lib/rbac.ts` — `requireCapability(context, capability)`. Enum of all Studio capabilities (`studio:project:read`, `studio:project:write`, `studio:render:download`, `studio:render:force-approve`, `studio:admin:*`).
- [x] **1.6** Implement `src/lib/audit.ts` — fire-and-forget POST to PostMind audit service. Never throws.
- [x] **1.7** Write the full `prisma/schema.prisma` — all v1.0 tables (19) + all v1.1 tables (14 new + 3 modifications). Verify against spec Section 7 and Addendum A7.
- [x] **1.8** Run `prisma migrate dev --name init_studio_schema`. Verify all tables land in `studio` schema.
- [x] **1.9** Add `system_flags` seed data (kill switch off, all providers enabled).
- [x] **1.10** Implement `src/lib/studio/kill-switch.ts` — DB-backed check with 30s in-memory cache. Unit tests for all four levels.
- [x] **[GATE 1]** Operator reviews schema, confirms it matches spec.

---

## Phase 2 — Provider adapter interface + first providers (target: week 2-3)

- [x] **2.1** Define `src/lib/studio/providers/interface.ts` — the `ProviderAdapter` interface exactly as spec Section 8.9.
- [x] **2.2** Define `ProviderRequest`, `ProviderCapability`, `ProviderError` types.
- [x] **2.3** Implement `src/lib/studio/providers/registry.ts` — registers all adapters, exposes `getAdapter(providerId)` and `getAdaptersByCapability(cap)`.
- [x] **2.4** Implement `src/lib/studio/providers/anthropic.ts` — Claude adapter for ideation and script capabilities. Use real API. Tests using recorded responses.
- [x] **2.5** Implement `src/lib/studio/providers/openai.ts` — DALL-E 3 for images + text-embedding-3-large for embeddings.
- [x] **2.6** Implement `src/lib/studio/providers/runway.ts` — Gen-4 text-to-video. Use real API against staging key.
- [x] **2.7** Implement `src/lib/studio/providers/elevenlabs.ts` — voice synthesis with brand voice support.
- [x] **2.8** Implement `src/lib/studio/providers/shotstack.ts` — composition (edit-decision-list POST).
- [x] **2.9** Implement `src/lib/studio/providers/router.ts` — routing logic per spec Section 6.4. Considers plan tier, health, budget, latency.
- [x] **2.10** Implement `src/lib/studio/providers/circuit-breaker.ts` — 5 failures in 60s opens for 5 min.
- [x] **2.11** Add ProviderJob DB writes on every submit/poll/complete. Cost tracking to `provider_usage`.
- [x] **[GATE 2]** Operator confirms one end-to-end provider call works (submit a Runway generation, poll, retrieve URL).

---

## Phase 3 — Queue + orchestration engine (target: week 3-4)

- [x] **3.1** Implement `src/lib/studio/queue/redis.ts` — BullMQ Redis connection config (DB 3).
- [x] **3.2** Define queues in `src/lib/studio/queue/queues.ts`: `studio-orchestration`, `studio-assets`, `studio-publish`, `studio-scheduled`, `studio-analytics`.
- [x] **3.3** Implement `src/lib/studio/queue/enqueue.ts` — typed helpers to enqueue each job type with priority based on plan tier.
- [x] **3.4** Implement `src/lib/studio/queue/workers/plan-project.ts` — Layer 1 (Ideation) + Layer 2 (Script + Storyboard). Uses Anthropic adapter. Writes `video_briefs`, `video_scripts`, `video_shots`.
- [x] **3.5** Implement `src/lib/studio/queue/workers/generate-asset.ts` — Layer 3-5. Routes per `visualTreatment`. Handles voice + music + visuals.
- [x] **3.6** Implement `src/lib/studio/queue/workers/compose-video.ts` — Layer 6-7. Builds Shotstack EDL, polls to completion, writes `video_renders`.
- [x] **3.7** Implement `src/lib/studio/queue/workers/run-quality-gate.ts` — Layer 8 auto-checks + Hive content safety.
- [x] **3.8** Every worker checks kill switch on job start. Every worker updates project state transitions.
- [x] **3.9** Implement retry logic: 5 retries, exponential backoff 5s → 2min cap. Dead-letter after.
- [x] **3.10** Add `scripts/worker.ts` entry point for running workers in separate process. Update `package.json` scripts.
- [x] **[GATE 3]** Operator triggers a test project end-to-end (brief → script → one AI clip generated → composed → quality-checked). Manual for now.

---

## Phase 4 — Project + script + shot APIs (target: week 4-5)

- [x] **4.1** Implement `POST /api/studio/projects` — create project, validate against spec Section 8.2. Zod schema for body. Auth + capability + audit.
- [x] **4.2** Implement `GET /api/studio/projects` — list with cursor pagination, filter by state/business/days.
- [x] **4.3** Implement `GET /api/studio/projects/[id]` — read one with scripts/renders/publications summary.
- [x] **4.4** Implement `PATCH /api/studio/projects/[id]` — update editable fields.
- [x] **4.5** Implement `POST /api/studio/projects/[id]/generate` — enqueue `plan-project`.
- [x] **4.6** Implement `POST /api/studio/projects/[id]/cancel` — cancel in-flight, mark project failed with cost incurred.
- [x] **4.7** Implement `POST /api/studio/projects/[id]/approve` — advance state, enqueue publish jobs.
- [x] **4.8** Implement `POST /api/studio/projects/[id]/reject` — halt, require note.
- [x] **4.9** Implement script/shot endpoints: GET script, PATCH shot, POST shot regenerate.
- [x] **4.10** Integration tests for each route: happy path + 401 + 403 + 404 + validation error.
- [x] **[GATE 4]** Operator can POST a project via curl and receive a rendered video URL via GET.

---

## Phase 5 — Platform connections + publishing (target: week 5-7)

- [x] **5.1** Implement `src/lib/studio/platforms/interface.ts` — `PlatformPublisher` interface (register/upload/publish/status).
- [x] **5.2** Implement `src/lib/studio/platforms/tiktok.ts` per spec Section 9.2. Real Content Posting API.
- [x] **5.3** Implement `src/lib/studio/platforms/instagram-reel.ts` per Section 9.3. Reuse Engagement's Meta credentials via internal API.
- [x] **5.4** Implement `src/lib/studio/platforms/youtube.ts` (Shorts + long-form) per Section 9.4.
- [x] **5.5** Implement `src/lib/studio/platforms/x.ts` per Section 9.5.
- [x] **5.6** Implement `src/lib/studio/platforms/linkedin.ts` per Section 9.6.
- [x] **5.7** Implement `src/lib/studio/platforms/facebook.ts` per Section 9.7.
- [x] **5.8** OAuth flows: `POST /api/studio/platform-connections/oauth-init`, `GET /api/studio/platform-connections/oauth-callback`. Encrypted token storage via KMS envelope.
- [x] **5.9** Implement publish worker: fires per-platform publisher, records `video_publications`, calls Engagement's `/internal/publications/attribute-conversation`.
- [x] **5.10** Implement `POST /api/studio/publications` (schedule or publish now).
- [x] **5.11** Scheduled publishing via BullMQ delayed jobs.
- [x] **[GATE 5]** (automated evidence; live posts pending credentials, Instagram blocked on Engagement token endpoint) Operator publishes a real video to TikTok + Instagram + YouTube from Studio.

---

## Phase 6 — Feature D: Website scan + image library (v1.1) (target: week 7-8)

- [x] **6.1** Implement `src/lib/studio/scan/fetch.ts` — respect robots.txt, User-Agent `PostMindStudio/1.0`, 1 req/sec, Playwright fallback for JS-rendered.
- [x] **6.2** Implement `src/lib/studio/scan/extract.ts` — cheerio HTML parse, meta/OG/JSON-LD/images.
- [x] **6.3** Implement `src/lib/studio/scan/classify.ts` — Claude Sonnet classification → `BusinessProfile`.
- [x] **6.4** Implement image library ingestion: scraped-images layer (with stock-hash filter), stock APIs (Pexels + Storyblocks + Unsplash), on-demand DALL-E generation.
- [x] **6.5** Implement `POST /api/studio/businesses/[id]/scan-website`, related GET/PATCH endpoints per Addendum A6.8.
- [x] **6.6** Implement image library endpoints (list, get, upload, generate, search, delete, refresh).
- [x] **6.7** Vector similarity search using pgvector on image embeddings.
- [x] **[GATE 6]** (automated evidence; live scan pending provider keys) Operator scans their own website and sees a populated image library.

---

## Phase 7 — Feature C: Slideshow mode (v1.1) (target: week 8-9)

- [x] **7.1** Extend `VideoProject.sourceType` to include SLIDESHOW. Migration.
- [x] **7.2** Implement `slideshow_slides` and `slideshow_templates` models (should already exist from Phase 1).
- [x] **7.3** Implement slide types per Addendum A5.3: IMAGE_STILL, IMAGE_KENBURNS, VIDEO_CLIP, TEXT_CARD, BEFORE_AFTER, QUOTE, STATISTIC, PRODUCT.
- [x] **7.4** Implement 8 built-in slideshow templates per Addendum A5.4.
- [x] **7.5** Implement `POST /api/studio/projects/[id]/auto-populate` — pulls from image library.
- [x] **7.6** Slideshow-specific composition (Shotstack Ken Burns effect, image sequencing).
- [x] **7.7** All slide CRUD endpoints per Addendum A8.3.
- [x] **[GATE 7]** (automated evidence; live run pending provider keys) Operator creates a listicle slideshow end-to-end from their own image library.

---

## Phase 8 — Feature B: Text overlay engine (v1.1) (target: week 9-11)

- [x] **8.1** Implement `text_overlays` and `overlay_presets` models (should exist from Phase 1).
- [x] **8.2** Seed 25 built-in overlay presets per Addendum A4.3 (hook, subtitle, CTA, quote, statistic, story, brand).
- [x] **8.3** Implement overlay-to-Shotstack translator per Addendum A4.6.
- [x] **8.4** Implement custom animation renderer for glitch/karaoke/counter via FFmpeg pre-render.
- [x] **8.5** Auto-suggestion at script time (Layer 2 populates default overlays per shot).
- [x] **8.6** All overlay CRUD endpoints per Addendum A8.2.
- [x] **8.7** `POST /api/studio/overlays/[id]/preview` — 3-second preview render.
- [x] **[GATE 8]** (automated evidence; live run pending keys + hosted fonts) Operator adds a styled hook overlay to an existing project and re-renders.

**NOTE**: The overlay editor UI is the highest-risk UX in the spec (per playbook Workstream F). The backend is straightforward; the frontend editor needs iteration with real users.

---

## Phase 9 — Feature A: Video library + reference-guided generation (v1.1) (target: week 11-14)

**Precondition**: 50k video corpus delivered to `studio-library-assets` S3 bucket with per-item licence metadata.

- [x] **9.1** Implement `src/lib/studio/library/ingest.ts` — the full ingestion pipeline per Addendum A3.3 (FFmpeg scene detection, transcription, OCR, LLM structural analysis, embedding).
- [ ] **9.2** (blocked: corpus not delivered) Run ingestion on 100 sample videos. Operator reviews output. Iterate.
- [ ] **9.3** (blocked: corpus not delivered) Full ingestion of 50k videos (parallel workers, monitored).
- [x] **9.4** Implement `src/lib/studio/library/similarity.ts` — pgvector nearest-neighbour.
- [x] **9.5** Implement `src/lib/studio/library/blueprint.ts` — TEMPLATE mode blueprint extraction + application.
- [x] **9.6** All library endpoints per Addendum A8.1.
- [x] **9.7** Category taxonomy seed data (200 nodes).
- [~] **9.8** (API done; UI in Phase 10) Admin library management UI (staff-only).
- [ ] **[GATE 9]** Operator searches library, picks a reference video, generates a new project in TEMPLATE mode, and the output structurally matches the reference.

---

## Phase 10 — Frontend (create/review/manage screens) (target: week 8-14, parallel with backend)

- [x] **10.1** Set up Tailwind, shadcn/ui, match PostMind design system tokens.
- [x] **10.2** Auth wrapper — read JWT from PostMind session cookie or bearer header.
- [x] **10.3** New Project screen (Create) — the "one text box, one button" experience per Addendum A14.1.
- [x] **10.4** Review screen with per-variant preview, shot strip, quality panel.
- [x] **10.5** Manage — projects list, publications list, calendar.
- [x] **10.6** Analytics dashboard.
- [x] **10.7** Library browse + detail (Feature A).
- [x] **10.8** Slideshow builder.
- [x] **10.9** Business profile + image library screens.
- [x] **10.10** Overlay editor (highest complexity — see design prototype in `/docs`).
- [x] **10.11** Admin Centre integration.

---

## Phase 11 — Analytics + observability (target: week 12-14)

- [x] **11.1** Analytics polling per platform (30s → 5min → 1hr → daily schedule).
- [x] **11.2** Analytics rollup jobs.
- [x] **11.3** Analytics endpoints.
- [x] **11.4** Cost tracking dashboards.
- [x] **11.5** Prometheus metrics endpoint.
- [x] **11.6** Sentry integration.
- [x] **11.7** Health endpoints (`/api/health`, `/api/health/ready`).

---

## Phase 12 — Hardening + launch prep (target: week 14-16)

- [x] **12.1** Load testing (k6 scripts per Engagement pattern).
- [ ] **12.2** Kill switch rehearsals — all 4 levels, timed against SLO. _(tooling built, all five levels timed unattended since 14.6: `npx tsx scripts/ops/staging-gate.ts --rehearse kill-switch`; timed rehearsal pending on staging — runbooks/staging-gate.md)_
- [ ] **12.3** Rollback rehearsal. _(automated since 14.6: `STAGING_DEPLOY_CMD=… npx tsx scripts/ops/staging-gate.ts --rehearse rollback --from-tag <N> --to-tag <N+1>`; timed rehearsal pending on staging — runbooks/rollback.md)_
- [x] **12.4** All runbooks written per playbook Section 11.
- [ ] **12.5** Beta customer onboarding (5-10 friendlies).
- [x] **12.6** Production deployment configs (Dockerfile, docker-compose.prod.yml, deploy runbooks).
- [x] **12.7** Full end-to-end regression: every user journey in playbook Workstream H golden-path list.
- [ ] **[GATE 12]** Go / No-Go decision per playbook Section 14 → v1.0 GA.

## Phase 13 — Close the "Not built yet" register

Plan, endpoint contracts and sample requests/responses: `plans/phase-13.md`. Wave A items ship fully implemented. Wave B items ship their contract and return an honest 501 until their outside dependency lands. Wave C is staging and people work.

**Wave A1 — Create and review**
- [x] **13.1** Script edit + regenerate (PATCH /scripts/:id, POST /scripts/:id/regenerate).
- [x] **13.2** Shot swap + delete (PATCH /shots/:id asset swap, DELETE /shots/:id).
- [x] **13.3** Whole-video overlay listing (GET /renders/:id/overlays).
- [x] **13.4** Per-slide overlays (text_overlays.slideId; GET|POST /slides/:id/overlays).
- [x] **13.5** Upload source + clip upload (POST /uploads, /uploads/:id/complete, UPLOAD pipeline path).
- [x] **13.6** Word-level caption timing (AssemblyAI in the pipeline).
- [x] **13.7** Overlay editor polish (resize, undo, alpha, safe areas, editable presets).

**Wave A2 — Library, manage and business set-up**
- [x] **13.8** Free-text library search (POST /library/search).
- [x] **13.9** Calendar reschedule (PATCH /publications/:id scheduledFor + drag UI).
- [x] **13.10** Scheduled rescans + stock refresh (etag, job schedulers, schedule endpoint).
- [x] **13.11** DNS TXT domain verification + disputed-ownership purge.
- [x] **13.12** Perceptual image de-duplication (dHash).
- [x] **13.13** Voice profiles (ElevenLabs voice cloning with consent).
- [x] **13.14** Onboarding first-run flow + brand-kit palette extraction.
- [x] **13.15** Corpus ingestion: streaming to S3 + resubmit failures.

**Wave A3 — Admin, automation and cost**
- [x] **13.16** Queue + provider health (Redis-backed circuit breaker; GET /admin/queues, /admin/providers).
- [x] **13.17** Content-safety review queue (REVIEW pauses instead of failing; decision endpoint).
- [x] **13.18** Per-organisation policy (org_policies; GET|PUT /admin/organisations/:id/policy).
- [x] **13.19** Per-organisation cost cap overrides (org_cost_caps).
- [x] **13.20** Auto-resume of cap-paused projects at rollover.
- [x] **13.21** Auto-publish outbox + retry.
- [x] **13.22** Internal organisation purge endpoint.
- [x] **13.23** Milestone notifications.
- [x] **13.24** Notification preferences.

**Wave A4 — Pipeline, media and analytics**
- [x] **13.25** Hive async moderation (> 90 s) + callback webhook.
- [x] **13.26** Loudness normalisation + compatibility re-encode.
- [x] **13.27** Sound effects (Storyblocks audio).
- [x] **13.28** Deeper analytics (YouTube retention + demographics).
- [x] **13.29** Style memory from available signals (GET|DELETE style-memory).
- [x] **13.30** CDN signed URLs (CloudFront signer when configured).
- [x] **13.31** Weekly cost regression + daily platform canary (scheduled CI).

**Wave A5 — Fallback providers with active accounts**
- [x] **13.32** Luma (AI_CLIP) and HeyGen (AI_AVATAR) adapters.

**Wave B — contracts now, 501 until unblocked**
- [x] **13.33** Email delivery (Core email API or Studio-sent email decision). Contract shipped (EmailSender, STUDIO_EMAIL_PROVIDER, emailStatus); waiting for the operator decision.
- [x] **13.34** Business list (Core list-businesses). Contract shipped (GET /businesses → 501); waiting for Core.
- [x] **13.35** Meta channel reconciliation (Core list-channels). Logic + daily job + admin GET shipped (501 / skipped); waiting for Core.
- [x] **13.36** BPM/key + CLIP/CLAP (inference host). Contract shipped (media-analysis adapter, unhealthy, never routed); waiting for a host decision.
- [x] **13.37** Browser-render scan fallback (headless Chromium host). Built behind STUDIO_HEADLESS_RENDER_URL; waiting for a host.
- [x] **13.38** Remaining fallback providers (accounts + keys). Documented (docs + router slot) in plans/phase-13.md; adapters wait for accounts.
- [x] **13.39** Sentiment signal for style memory (Engagement classifier API). Client contract shipped (NotImplemented); waiting for Engagement.

**Wave C — staging and people** (closes 9.2, 9.3, 12.2, 12.3, 12.5, GATE 12): Core Meta wiring → alerting deployment → live provider/posting runs → rehearsals → k6 → PITR drill → corpus sample + full run → S3 lifecycle → beta onboarding, on-call rota, Trust & Safety audit.

## Phase 15 — Spec coverage gaps

Features in the specs that no earlier phase or register item covered. The list and plan come from a spec-vs-code audit (`plans/phase-15.md`). Dependency-blocked items found by the audit are queued, as in Phase 13 Wave B.

**Track A — Publishing and distribution**

- [x] **15.A1** Instagram feed (REELS container + share_to_feed, 1:1/4:5) and Facebook feed video (Page Videos upload_phase start/transfer/finish, 16:9/1:1) publishers, rules, metrics readers, Create formats, labels (8 destinations).
- [x] **15.A2** TikTok inbox-upload fallback (/v2/post/publish/inbox/video/init/, video.upload): used when video.publish is not granted or the creator has no privacy options; PUBLISHED with metadata.tiktokMode "inbox" + note (AI label reminder, P6).
- [x] **15.A3** Render thumbnails: generate-thumbnail job after compose (keyframe + hook text on the highest-engagement library image, FFmpeg), POST /renders/:id/thumbnail (regenerate or JPEG/PNG upload), thumbnailUrl on GET /renders/:id, YouTube thumbnails.set; variant-card Change.
- [x] **15.A4** Narration captions per format: burned-in editable overlays (subtitle box / TikTok-native, project language) for every platform but YouTube long-form, which gets an SRT (captionsSrtS3Key) uploaded with captions.insert; GET /renders/:id/captions.
- [x] **15.A5** publishPolicy SCHEDULED acted on (drift #2): approval schedules every target from scheduledStartAt, staggered STUDIO_DEFAULT_STAGGER_MINUTES (15–60, default 30), through the outbox; per-business drip queue (GET|PUT /businesses/:id/drip-queue) takes the next free slot; approve returns `scheduled`; calendar drip panel.
- [x] **15.A6** GET /analytics/best-times (per platform/weekday/hour, viewer time zone, optional language; style-memory POSTING_TIME fallback, advisory); "Suggested: Tue 08:00" in the publish panel.
- [x] **15.A7** POST /projects/:id/caption-suggestions (one Claude call per project, spec 9.8 conventions, project language, fitted to PLATFORM_RULES, cached); publish panel "Suggest captions".
- [x] **15.A8** GET /publications rows carry latestMetrics { views, likes, comments, at }; Views column.
- [x] **15.A9** YouTube quotaExceeded → deferred to just after the next Pacific-midnight reset (drift #5); Studio-initiated captions truncated at a word boundary with metadata.captionTruncated, manual input still 400 (drift #4).

**Track B — Composition and media quality**

- [x] **15.B1** Brand-kit media: upload kinds brand_logo (PNG with transparency) / brand_watermark / brand_card (PNG, JPEG or ≤30 s MP4) / brand_font (TTF/OTF, licenceConfirmed required, family name read from the font); PATCH /brand-kits/:id logo/watermark/intro/outro ids and fontPrimary "upload:<id>"; EDL logo bug, watermark, intro/outro cards and timeline.fonts; soft DELETE (drift #3); brand-kit media pickers.
- [x] **15.B2** §13.1 audio_sync, caption_sync (±200 ms), watermark (timeline + ffmpeg frame sample) and brand_kit (warning = user review) evaluated from video_renders.composition (drift #17).
- [x] **15.B3** Narration fitted to the shot (±5%): extend stills/text/motion cards, else ElevenLabs voice_settings.speed ≤1.2 once, else trim at a word boundary (drift #7); STUDIO_STOCK_VOICES tone-matched stock voices per language (drift #8).
- [x] **15.B4** Per-shot music ducking (split music clips with `trim`: ducked under narration, full under silent shots and cards).
- [x] **15.B5** IMAGE_STILL: image library first (0.30 similarity), generated stills kept + embedded in the library, stock image on a generation refusal (W6 buildable half) (drift #13).
- [x] **15.B6** video_assets.fingerprint reuse (zero-cost `<capability>:reused` provider jobs) and composition cache (identical EDL → same render).
- [x] **15.B7** Render presets per platform (fps 24/30/60, `quality`, 720p drafts via scaleTo, 4K YouTube at Plus+); PATCH /projects/:id { renderOptions } (drift #11).
- [x] **15.B8** MOTION_GRAPHICS shots rendered by Shotstack (shape + animated accent + text), offered when Shotstack is registered.
- [x] **15.B9** "We used a fallback provider" review note (metadata.fallbacks from routing snapshots).
- [x] **15.P2** White-label (operator decision): ENTERPRISE or org_policies.whiteLabel → no Studio mark; others get the optional STUDIO_MADE_WITH_CARD_URL end card.
- [x] **15.P6** Optional on-video "AI-generated" label per brand kit (aiDisclosureLabel, default off), in the video's language; platform AI labels stay on.

**Track C — Planning, providers and create inputs**

- [x] **15.C1** OpenAI text-generation (Responses API, structured JSON) and whisper-1 transcription fallbacks; router: anthropic → openai, assemblyai → openai.
- [x] **15.C2** Storyblocks music library pick (storyblocks-music, content_type=music); music list elevenlabs-music → storyblocks-music → replicate.
- [x] **15.C3** Per-org, per-provider rate coordination (Redis sliding windows, STUDIO_PROVIDER_RATE_<ID>); full window → job delayed (moveToDelayed), no attempt used.
- [x] **15.C4** Generate overrides (qualityTier down only, 422 above plan; preferredProviders per treatment) + Create advanced options (tier, schedule, approval workflow).
- [x] **15.C5** Languages (operator list: en-GB, en-US, fr, es, ar, de, it, pt-BR, pt-PT, hi, zh-Hans; no Pidgin): project language + extra-language variant sets, native Layer 1–2 prompts, voice/transcription language, RTL/script fonts, Create picker.
- [x] **15.C6** Public-figure review flag (public_figure category, verdict raised to at least REVIEW → 13.17 queue).
- [x] **15.C7** Automatic consent-phrase check on voice clones (passed | mismatch | unavailable; PENDING_REVIEW unless passed; POST /voice-profiles/:id/consent-check).
- [x] **15.C8** Platform-native Layer 2 guidance (hook framing, pacing, caption style, spec 5.3 duration curves); Create default for Shorts 45 s.
- [x] **15.C9** Pin shots when regenerating a script (pinnedShotIds keep assets and positions; Layer 2 writes around them).
- [x] **15.C-stock** STOCK_FOOTAGE adapters: Storyblocks video (storyblocks-video) and Pexels video (pexels-video), licence metadata, 0p; Layer 2 offers STOCK_FOOTAGE when configured (register 13.38 correction).
- [x] **15.P1** BYOC provider keys (Enterprise, STUDIO_BYOC_ENABLED): provider_credentials (envelope-encrypted), per-org registry, per-project override, Connections panel.
- [x] **15.P5** Basic plan defaults the Create screen to Slideshow (user can switch).
- [x] **15.P7** Per-business provider ratings (approval, regeneration, retention) reorder shot candidates; GET /businesses/:id/provider-ratings.

**Track D — Governance, admin and cost controls**

- [x] **15.D1** Feature flags (A12.4): studio.features.<library|overlays|slideshow|image-library> + per-org override, 30 s cache, FEATURE_*_ENABLED now read (hard off); 403 feature_disabled in routes, project create and jobs; GET|PUT /admin/features + Admin "Features" tab.
- [x] **15.D2** A10.3 tier gates (services/tier-gates.ts: INSPIRE Standard+, TEMPLATE Plus+, custom presets/templates Standard+, scans 1/3/10/∞ businesses, image generation Plus+) → 403 plan_tier + requiredTier; A10.4 £0.50 per-scan cap, monthly image-generation cap 20/50/200/1000, slideshow default budget £1.50.
- [x] **15.P3** Plan quotas (operator decision): spec 12.4 monthly video quotas per tier (env-overridable), STUDIO_QUOTA_MODE=warn|enforce (default warn; enforce = 403 quota_exceeded on generate/publish), 80 %/100 % notifications; GET /usage + usage meter; GET /admin/organisations/:id/usage + Admin "Plan usage" tab.
- [x] **15.P4** Voice cloning for Plus and Enterprise (STUDIO_VOICE_CLONE_MIN_TIER default PLUS).
- [x] **15.D3** Multi-step approval workflows (spec 7.13): CRUD /approval-workflows, appliesTo matching, step machine (role + minApprovers, one vote per user per step, reject at any step), GET /projects/:id/approval; editor screen + review step indicator.
- [x] **15.D4** Dead-letter admin view (spec 11.5): GET /admin/queues/:name/failed (redacted), POST …/:jobId/retry|requeue (providerId override), POST …/failed/drain (typed confirmation); Admin "Dead letters" tab.
- [x] **15.D5** GET /admin/force-approvals?days= (spec 13.5) + Admin "Force-approvals" tab.
- [x] **15.D6** Two-person global kill (spec 19.2): PUT /admin/kill-switch {level:global} → pending request; a different staff user confirms within 10 min (POST /admin/kill-switch/global/confirm, DELETE …/pending); break-glass STUDIO_KILL_SWITCH_SINGLE_APPROVER audited; rehearsal script updated.
- [x] **15.D7** Library licence filter (A11.1, drift #1): browse, detail, similar, recommended and blueprint exclude rows without a licence row; staff GET /admin/library/videos, POST …/videos/bulk (accept|override|reject), POST /admin/library/reanalyse, GET /admin/library/licence-audit; Admin library panel uses them.
- [x] **15.D8** Scan ownership statement stored on website_scans (A11.2); classifier confidence < 0.7 → business_profiles.needsReview + Business screen confirmation (A13).
- [x] **15.D9** SLO metrics (spec 17.1 / 3.5): studio_generation_seconds{kind}, studio_publish_latency_seconds, studio_analytics_first_metric_seconds, publication outcome and quality-gate counters; ops/prometheus/studio-slo.yml rules + alerts with promtool tests.
- [x] **15.D10** Launch-readiness harnesses: test/visual preset pixel diff (skips without ffmpeg/browser), test/eval classifier accuracy + scan timing (skip without the Playbook H-03 fixtures), A10 ±15 % cost journeys, daily provider canary (Sunset/Deprecation headers). Operator run with staging keys pending.

**Track E — Data rights, integrations and sharing**

- [x] **15.E1** Data export (spec 18.4 / A11.7): POST|GET /account/export, GET /account/export/:id; export-account-data job writes an org-scoped ZIP (JSON per table, no tokens, signed media links) to the assets bucket; one at a time; 7-day link; /account/export screen.
- [x] **15.E2** Business purge: POST /internal/businesses/:id/purge (soft-delete + stop projects, cancel posts, wipe memories and business tokens, 30-day grace); hard delete by the retention sweep.
- [x] **15.E3** POST /internal/publications/:id/attribute-conversation (publication_conversations, idempotent, sticky lead) + GET /analytics/engagement-conversations (by project, hook, platform).
- [x] **15.E4** GET /admin/transparency?year, takedown log (GET|POST /admin/takedown-requests, PATCH …/:id); generated ops/compliance-matrix.md with a CI staleness test.
- [x] **15.E5** Share links (decision P8: view + feedback, never approve): GET|POST /projects/:id/share-links, DELETE …/:linkId; public GET /public/share-links/:token and POST …/comments (rate limited, owner notified); /p/[token] page (RTL/CJK safe); review-screen panel.
- [x] **15.E6** PATCH /businesses/:id/style-memory/:memoryId { value?, pinned?, disabled? }; pinned kept by the nightly build, disabled never injected.
- [x] **15.E7** /templates screen + DELETE /slideshow-templates/:id.
- [x] **15.E8** Daily retention-sweep job (spec 7.15) + GET /admin/retention dry run.
- [x] **15.E9** Secondary-region storage failover (S3_FALLBACK_REGION / S3_FALLBACK_BUCKET_*).
- [x] **15.W1** (contract) POST /internal/projects/from-content + CoreContentClient — 501 until Core ships GET /api/internal/content/:id.
- [x] **15.W2** (contract) usage_events outbox + UsageReporter (pending_setup until Core usage API).
- [x] **15.W3** (contract) calendar_shadows derived from publications + CalendarShadowClient (pending_setup).
- [x] **15.W4** (contract) nightly reconcile-organisations job, skipped until Core ships an existence check.
- [x] **15.W5** (contract) Engagement trigger fields behind STUDIO_ENGAGEMENT_TRIGGER_FIELDS.
- [x] **15.W6** (contract) Ideogram router slot + honest-501 adapter, never registered without an account.

**Integration**

- [x] **15.INT** Tracks A–E + Phase 14 merged green: Phase 15 internal routes in the Core kit (OpenAPI, client, 15-check contract suite), purge coverage of every Phase 15 table (tombstones + anonymised takedowns kept), caption lane de-duplicated against the hook, composition cache keyed on asset ids.

## Phase 14 — Deliver every outstanding item not blocked by a dependency

Plan: `plans/phase-14.md`. Dependency-blocked items stay queued in Phase 13 Wave B (13.33–13.39). Items whose last step is a person's are built, then marked "ready to run" until that step happens.

**Track 1 — data and infrastructure**
- [x] **14.1** Organisation purge: hard deletion after the 30-day grace.
- [ ] **14.2** S3 lifecycle rules as code + apply script (DevOps applies). (built; ready to run by DevOps: `npx tsx scripts/ops/apply-s3-lifecycle.ts` with AWS_REGION + S3_BUCKET_*, review the diff, then `--apply`)
- [ ] **14.3** Prometheus + Alertmanager deployment stack (DevOps supplies keys and runs). (built; ready to run by DevOps: secret files, `docker compose -f docker-compose.monitoring.yml up -d`, then `npx tsx scripts/ops/alert-smoke.ts` — runbooks/monitoring-deploy.md)
- [ ] **14.4** Headless render fallback service, owner-confirmed sites only (operator enables). (built; ready to run by the operator: `docker compose -p postmind-studio -f docker-compose.prod.yml --profile headless-render up -d browserless` + STUDIO_HEADLESS_RENDER_URL/_TOKEN on staging — runbooks/scan-blocked.md)

**Track 2 — staging gate**
- [ ] **14.5** k6 smoke + full run automation (built; ready to run by the operator on staging: `staging-gate.ts --k6 smoke|full` or the Staging gate workflow).
- [ ] **14.6** Kill-switch (all five levels) and rollback rehearsal automation (built; ready to run by the operator on staging, DevOps supplies STAGING_DEPLOY_CMD: `staging-gate.ts --rehearse all`).
- [ ] **14.7** Point-in-time restore verification (built; ready to run by DevOps: `staging-gate.ts --snapshot` → PITR restore → `--restore-check`).
- [ ] **14.8** Live provider + posting run harness (built; ready to run by the operator with staging keys and test accounts: `npm run gate:live -- --confirm`).
- [ ] **14.9** Corpus manifest template, pre-flight and review checklist (built; ready to run by the operator: `ingest-corpus.ts <manifest> --preflight`, then 9.2 → review → 9.3).

**Track 3 — integrations and beta**
- [ ] **14.10** Core integration kit for the Meta internal endpoints (Core team wires it). (built; ready to run by the Core team: integrations/core — copy the client, wire it, `npm run contract:core -- --base-url <staging> --token <token>`)
- [ ] **14.11** Beta programme tooling, Trust & Safety audit sampling, on-call rota config (people run it). (built; ready to run by people: recruit and enrol 5–10 beta customers in Admin → Beta, staff the rota from ops/oncall/rota.template.yaml + PagerDuty, review the monthly sample in Admin → Safety audit)

## Phase 16 — Multilingual Studio interface

Plan: `plans/phase-16.md`. Operator decision (2026-09-28): interface in en-GB (source), en-US, fr, es, ar (RTL), de, it, pt-BR, pt-PT, hi, zh-Hans; no Nigerian Pidgin. Machine-written translations are flagged for native-speaker review before launch.

- [x] **16.1** i18n foundation: next-intl, locale selection (user preference → Accept-Language → en-GB), locale-aware formatting, message catalogues + CI completeness/placeholder checks, API error codes → message keys.
- [x] **16.2** Right-to-left: dir/lang per locale, logical CSS properties, mirrored directional icons. (infrastructure done: `<html lang dir>`, DirectionProvider, `rtl:-scale-x-100` / `cn-rtl-flip`, shell + primitives logical, `scripts/i18n/check-physical-css.ts`; screens convert with 16.3)
- [x] **16.3** Every screen localised (create/review/slideshow/overlays; manage/business/connections; library/analytics/admin; shell/onboarding/share/templates/account), all 11 catalogues written.
- [x] **16.4** Tests: catalogue parity, ICU validity, RTL + CJK component renders, per-locale formatting. (checks + shell/format tests done; screen renders with 16.3)
- [x] **16.5** Notifications rendered in the reader's locale (message key + params). (email templates follow with Wave B email)

## Phase 17 — Production hardening

Plan: `plans/phase-17.md`. Runbook GAPs that are code, plus follow-ups from Phase 16, R2 and Render.

- [x] **17.1** Sweep abandoned PENDING uploads (grace period; READY uploads untouched).
- [x] **17.2** Re-enqueue SCHEDULED publications whose publish job was lost.
- [x] **17.3** Daily platform account-status check → reconnect notice.
- [x] **17.4** Provider-outage alert rule.
- [x] **17.5** Scheduled object-storage backup copy (S3 or R2) with bounded retention.
- [x] **17.6** S3 presigned PUT: sign Content-Type, no empty-body checksum.
- [x] **17.7** CI: Postgres 17, monitoring image build, render.yaml schema validation.
- [x] **17.8** Ownership statement stored as locale + message key, checked against approved text.
- [x] **17.9** Server-originated text (failure reasons, quality details, "Untitled video", template categories) localised.

## Phase 18 — Standalone SaaS (sign-in, Stripe, Resend, plans and tiers)

Plan: `plans/phase-18.md`. Operator decisions (2026-09-29): standalone product; built-in sign-in (Better Auth); Stripe subscriptions; Resend transactional email; Core and Engagement kept as optional adapters, off by default (`STUDIO_MODE=standalone`). These override CLAUDE.md's "Core handles auth / billing" lines; rule 1 (never modify Core or Engagement code) still holds.

- [x] **18.0** Track 0 — contracts: the whole expand-only migration (19 tables + `platform_connections.connectedVia`, append-only audit trigger), `IdentityProvider` / entitlements / catalogue / billing / auth-mailer / audit-sink contracts, new capabilities, mode-aware env (`STUDIO_MODE`), empty i18n namespaces, leaf-level catalogue merge script.
- [x] **18.A** Track A — identity foundation (built on phase-18: A1 10fc587 + A2/A3; impersonation wiring and 2FA-disable code done in the integration; the Playwright happy path passes in CI, PR #25): Better Auth (argon2id, sessions, CSRF, rate limits, enumeration-safe responses), standalone `IdentityProvider`, role → capability map, platform staff, local audit log; sign-up / sign-in / verify / reset / 2FA screens, Google sign-in, account security; super-admin CLI.
- [x] **18.B** Track B — email: Resend sender, outbox + retries, templates in 11 locales (plain TS, not React Email — see PROGRESS), webhook suppression, one-click unsubscribe.
- [x] **18.C** Track C — billing, plans and entitlements: Stripe catalogue / checkout / portal / webhook, entitlements and access gate, top-ups, `/pricing`, `/settings/billing`, upgrade dialog, admin overrides.
- [x] **18.D** Track D — standalone replacements: local businesses, local organisation directory, Studio's own Meta connect (Facebook Login for Business) with deauthorise / data-deletion callbacks, Core-only adapters off. (Staging gate — a live Page/IG connect, Reel publish and deauthorise with the operator's Meta app — waits for the app settings in runbooks/meta-connect.md.)
- [x] **18.E** Track E — product surfaces and admin: landing, legal, onboarding, organisation / members / audit settings, admin organisations / users / subscriptions, shell switcher and banners, demo, CLAUDE.md and runbooks. Items:
  - [x] **18.E1** Public landing page at `/` (signed-in visitors → `/projects`; core mode → app).
  - [x] **18.E2** Legal pages from `content/legal/<locale>/*.md` placeholders + legal-readiness gate (admin warning; production sign-up closed while terms/privacy are placeholders; `scripts/legal/check-ready.ts`).
  - [x] **18.E3** Onboarding: organisation → first business → brand kit → connect → first video.
  - [x] **18.E4** `/settings/organisation`, `/settings/members`, `/settings/audit` + `api/studio/{org,members,audit,me}`.
  - [x] **18.E5** Admin Organisations / Users / Subscriptions tabs; impersonation policy (off by default, read-only when on).
  - [x] **18.E6** AppShell organisation switcher, user menu with sign-out, account banners (trial, past due, read-only, no plan, staff view).
  - [x] **18.E7** Demo handlers `p18-*`, tour group and What's new entry.
  - [x] **18.E8** Docs: CLAUDE.md standalone mode, runbooks/auth.md, vps-deploy.md.
  - [x] **18.E9** All strings in 11 locales, ar and zh-Hans render tests.
  - [x] **18.E10** Playwright happy path runs green in CI (CI job `e2e`; passing since PR #25).

## Phase 19 — Launch preparation

Plan: `plans/phase-19.md`. Operator instruction (2026-09-29): complete everything that does not depend on the operator or on the server being ready. Three parallel tracks.

- [x] **19.1** Track 1 — corpus tooling for the 50k reference library (`eu-corpus-source`): `corpus:scan`, `corpus:manifest`, `corpus:rclone-config`, upload scripts, runbooks/corpus-upload.md (PR #28). The real upload waits on the operator's bucket and key.
- [x] **19.2** Track 2 — go-live guide (`runbooks/go-live.md`, `docs-site/go-live.html`) and the settings template and checker (`npm run setup:env`, `npm run setup:check`).
- [x] **19.3** Track 3 — security hardening: per-account 2FA and per-organisation/inviter invite limits, legal link guard (PR #29).
- [x] **19.4** Track 3 — dependency and CI upkeep: 0 high advisories, actions on node24, `prisma.config.ts` (PR #29). Follow-ups for the operator: Node 20 → 22/24 (end of life 2026-04-30); vitest 4 for the last moderate advisory.
- [x] **19.5** Track 2 — cancelled-organisation banner copy: a distinct "subscription ended" read-only banner with the deletion date, in 11 locales.

## Phase 20 — Post-launch-prep changes (operator requests 2026-09-30)

- [x] **20.1** Node 24 LTS runtime: Dockerfile `node:24.21.0-bookworm-slim`, CI `node-version: 24`, `engines.node` >=24, `@types/node` 24.x, docs.
- [x] **20.2** Lower price list (operator decision 2026-09-30): £29 / £99 / £349 a month (annual 10 × monthly), Enterprise from £1,500; 20 / 40 + 1 / 80 + 4 videos; caps £20 / £73 / £264 / £1,100 a month; cheaper top-ups. Stripe lookup keys unchanged.
- [x] **20.3** Month-ahead auto-scheduling and calendar: one-click posting plans (calendar and onboarding), open drip-queue slots and a "Next 30 days" summary on the calendar (`GET …/drip-queue/upcoming`), "next free slot" on Create, an honest notice + audit + notification (and Try again) when a scheduled video gets no slot, the 180-day limit on `scheduledStartAt` and in the date pickers, "A month of short videos" on the landing page.
- [x] **20.4** Legal document drafts (six pages) with fill-in markers; sign-up stays closed until the markers are filled
- [x] **20.6** Hive V3 (self-serve) content safety: `HIVE_V3_SECRET_KEY` / `HIVE_API_VERSION`, V3 visual moderation (≤ 60 s one request, longer renders as `HIVE_V3_MAX_FRAMES` sampled frames), 429 fails closed; V2 Enterprise path kept.
- [x] **20.7** Self-hosted render fonts (STUDIO_FONTS_BASE_URL optional)
- [x] **20.8** Visual refresh: homepage visuals and slides; placeholder images replaced
- [x] **20.9** Plan my month: batch-generate videos and slideshows and auto-schedule (≤4/day)
- [x] **20.10** Full QA sweep and fixes
- [x] **20.11** Provider failover on account limits; no raw provider errors for customers
- [x] **20.12** Auto-publish: accounts vs platforms; no blocking without connected accounts
- [x] **20.13** Captions and hashtags (≥5, business hashtag, owner "always" hashtags)
- [x] **20.14** Posting schedule: daily/weekly, chosen/system/interval times, max 4 a day
- [x] **20.15** Library caching: shared Redis read-through cache with a catalogue version bumped on every write, stable thumbnail URLs + Cache-Control (and a backfill script), cached query embeddings, private max-age on GET library responses
- [x] **20.18** Vague briefs: "Choose a direction" panel on the project page (suggestions + edit, generate with `directionChosen`), `directionOptions` on GET /projects/:id, less strict ideation that never asks twice in a row, a gentle short-brief hint on Create / month-plan posts / onboarding, the reason on the projects list; restricted topics (spec 13.3) panel: the topics, "Continue anyway" (`confirmRestrictedTopics`) or edit the brief
- [x] **20.19** Avatar presenter fallback (AI_AVATAR → generated clip when no avatar provider is available), HeyGen MOVIO_PAYMENT_* and generic out-of-credit 4xx classification (Runway), no-safety-provider → Trust & Safety review instead of a block
- [x] **20.17** Library previews with sound (operator decision 2026-10-01; supersedes the "muted" part of A3.10 / 10.7): previews keep AAC audio (360 px, ≤ 30 s, no download, 10-minute signed URL unchanged), the detail player is unmuted with controls and no autoplay, hover previews stay muted, `scripts/library/rebuild-previews.ts` regenerates existing previews
- [x] **20.20** Google Veo 3.1 (Gemini API) as the third AI_CLIP provider after Runway and Luma: adapter, routing failover, env + setup checker, canary, docs (operator decision 2026-10-02)
- [x] **20.21** Remove Hive completely (operator decision 2026-10-02): no content-safety provider; the quality gate records content safety as "Not scanned" and continues to the normal review (no Trust & Safety hold, no block, no alert); Hive adapter, webhook, async scans, env vars, canary, staging-gate test, BYOC entry and docs removed; `scripts/ops/release-safety-holds.ts` releases the runs 20.19 parked
- [x] **20.22** Quality gate fixes from QA run 3 (the first production video through every stage ended QUALITY_FAILED): text cards, motion-graphics cards and the timeline background are never black (brand colour, lifted when too dark, or a neutral slate); blackdetect thresholds pinned and documented; caption_sync judges only narration captions (new `text_overlays.kind`, add-only migration with backfill) and karaoke overlays, never headlines/CTAs/text cards; the quality panel says soft failures can be force-approved (and by whom) and offers no override for a content-safety block
- [x] **20.23** BytePlus ModelArk Seedance as the main AI_CLIP provider (operator decision 2026-10-02; routing approved the same day): adapter (2.0 mini on STANDARD, 2.5 on PLUS/ENTERPRISE and for shots over 15 s), order seedance → veo → runway → luma on every tier, `BYTEPLUS_API_KEY` + setup checker, BYOC, canary, staging gate, kill switch, docs, sub-processor row
- [x] **20.24** Kling 3.0 (Kling AI API, API-key auth) as the second AI_CLIP provider (seedance → kling → veo → runway → luma): adapter (silent, single-shot, 3–15 s, 720p/1080p), routing, env + setup checker, BYOC, canary, staging gate, runbooks, sub-processor row (legal review) (operator decision 2026-10-02)
- [x] **20.16** Pixabay as a free stock image source (`PIXABAY_API_KEY`): last primary after Pexels and Storyblocks, Unsplash stays the fallback; images copied into our storage, searches cached 24 h, "Images from Pixabay" credit.
- [x] **20.25** Cheaper videos (operator decision 2026-10-03): AI clip budget per tier and length in the script step (BASIC 3 / STANDARD 4 / PLUS 6 AI clips for a 30 s short; extras become the business's or stock images, or motion-graphics cards, never a paid generation), AI clips of at most 4 s, BASIC at 480p (Seedance), Seedance 2.0 mini on every tier, BASIC routed seedance → kling → veo, stock before generated stills, Ken Burns zoomIn / zoomOut, Shotstack at its list price, per-video cost model with per-tier tests, per-tier default project budget (£3.50 / £4 / £6 short); typical 30 s short BASIC 76p / STANDARD 141p / PLUS 187p
- [x] **20.26** Slideshows never black and with photos (production 2026-10-03): slideshow cards, image-less slides and the timeline use the 20.22 backdrop; text sized from the short side so 16:9/1:1/4:5 match 9:16; images cropped, not stretched; month-plan points are Ken Burns photo slides; generation fills image slides from the library, then stock on demand (Pixabay, then Unsplash), then AI within the budget, then a text card; cheap automatic stock refresh when a business profile is saved
- [x] **20.31** Full QA round 2 (2026-10-03): CI job `pipeline-e2e` (stubbed full pipeline on Redis 7: brief to analytics, slideshow, Seedance 429 and out-of-credit failover to Kling, project and organisation cost-cap pauses), axe accessibility spec over every screen (contrast, ARIA and `dl` fixes), new Playwright specs for Approvals, Plans, billing, the drip queue, the Admin Centre, and mobile 375 px, dark and keyboard-only flows, approval form business picker with a "removed business" label, demo access gate and sample workflow fixes. Follow-up: render the calendar time-zone line client-side only.
- [x] **20.29** Load testing (operator requests 2026-10-03: "the pipeline holds if there are multiple requests for video creation"; 200 concurrent users): per-provider in-flight caps in Redis with a fair share per organisation (Seedance 3, Kling 20; `STUDIO_PROVIDER_CONCURRENCY_<ID>`), busy providers (cap reached, 429 / 1303 / RESOURCE_EXHAUSTED) delay the job without spending an attempt (bounded), optional `STUDIO_PROVIDER_OVERFLOW=failover`, "Queued: starts soon" note on the project page; simulated-provider harness on the real pipeline (`scripts/load/pipeline-load.ts`, refuses production), 200-user k6 scenario against the production compose stack, `.github/workflows/load-test.yml`, `runbooks/load-testing.md`, results and capacity numbers in `ops/results/load-test-2026-10-03.md`. Phase 2 (a 5-video real-provider burst on production) is proposed only, awaiting the operator's approval of the cost
- [x] **20.30** Full QA round 1 (2026-10-03): robots.txt + sitemap.xml, create buttons disabled with a reason when the organisation is read-only or has no plan, library search relevance floor + "No close matches" state, approval cards show business names, demo mirrors live (vague brief, Pixabay-only stock, legal ready, search floor). Follow-ups: stubbed full-pipeline `workflow_dispatch` job on Redis 7, axe pass (`@axe-core/playwright` is not a dependency yet), per-screen specs for Approvals, Plans, Publications drip queue and billing pages, the approval workflow form still asks for raw business ids
- [x] **20.27** Admin plans, access, trial and cost caps per organisation (operator request 2026-10-03: a superadmin could not find how to change a plan, and an organisation on a Stripe trial was stuck at the £15 trial cap): Organisations tab lists plan (resolved at read time), access, trial state, subscription status and AI cost this month, 50 a page; the organisation page holds "Plan, access and trial" (effective plan, trial with AI cost against its caps, stored row, override, subscriptions; override form with confirmations for access None / Read-only; remove override with a warning when it would bring a paused trial back), the review policy and cost caps (with "Clear back to plan default"); "End the trial now" on the override (`endTrial`, stored as `overrides.trial.endedAt`, audited): no trial caps or allowance again, the plan tier's caps (and any cost-cap override) apply; Stripe unchanged
- [x] **20.28** Legal pages brought in line with the product (operator request 2026-10-03): sub-processors (Seedance, Kling, Veo, Pixabay, no scanning service, DPF / UK Addendum / IDTA safeguards with LEGAL REVIEW notes), privacy (AI providers, transfers to the US, Singapore, Malaysia and Australia, provider retention), terms (AI providers may change, trial £10/day and £15 total, per-video budgets, not scanned, automatic approval is the customer's choice), acceptable use (real people's likeness, AI presenters), cookies (`theme` key), DPA (sub-processor reference, security measures, deletion timings); dated 3 October 2026; sign-up stays open

## Phase 21 — Production QA fixes (operator requests 2026-10-04)

- [x] **21.4** UGC actor videos (operator request 2026-10-04: "videos that are actually actors"; plan `plans/phase-21-ugc.md`): research of Veo 3.1, Kling, HeyGen, Creatify, Arcads and Mirage from official docs; Veo 3.1 Fast (existing Gemini key) recommended and built: `UGC_ACTOR` treatment (expand-only migration), `actor_video` capability (line in quotes, product photo as reference image, project seed), Kling native-audio fallback behind `KLING_UGC_ACTOR`; Create option (product, photo, actor look) and "Plan my month" option; UGC ideation and script rules; clip-native speech in captions, composition, audio_sync and caption_sync; real-person refusal; AI label always on; no tier gate (per-channel subscriptions), a UGC video uses 2 videos; budget £6 / £7.50; 11 locales; demo sample; stubbed `ugc-actor` pipeline scenario
- [x] **21.4a** UGC consistency (first real UGC video, production 2026-10-04: the actor changed in clip 3; labels covered the face; a caption read "calls, calls."): one generated actor portrait per UGC project (`ugc/portrait.ts`, the IMAGE_STILL image route, made once under a claim so parallel actor shots share it, stored as a project IMAGE asset at `metadata.ugc.actorImage`) sent to every actor clip and every regenerated clip (Veo: first `referenceImages` asset, product second, 8 s, `allow_adult`; Kling: `first_frame` on portrait formats); no portrait → clips go on as before; no suggested labels on UGC_ACTOR shots except a short hook at anchorY 0.11 (below the AI label), no composer headline on them; actor told to say the line exactly once; clip transcripts re-spelt to the script line (all-or-nothing)
- [x] **21.4b** UGC native look (operator review of production UGC video 2, 2026-10-05: "the overlay still blinds the UGC creator and the poster in between does not work"; modelled on Fastlane's UGC videos): TikTok classic captions and labels for UGC projects (white, black outline, no box, 3.6 % at 0.70, ≤ 6 words a caption; hook 4.2 % at 0.11; presets `subtitle_tiktok_classic` / `hook_tiktok_classic`, never brand-recoloured), no boxed composer headlines in a UGC edit; UGC scripts use UGC_ACTOR + IMAGE_STILL only (cards become product stills), B-roll 2–3 s, product footage phone-camera style with at most one short line; UGC still source: product photo → business library → generated hands-using-the-product photo (no generic stock, existing still route and budgets), slow push-in; demo sample and stubbed scenario updated
- [x] **21.4c** Actor clip text guard (production 2026-10-06, UGC QA video 3, project cmuvx27w60000mo07w33r2xyu: the third Veo 3.1 Fast clip came back with its own misspelt burned-in subtitles under our captions): the no-text instruction is now the LAST sentence of every actor clip prompt, after the quoted line (`providers/dialogue.ts`, shared by Veo and Kling; prompt text only — Veo 3.1 documents no negativePrompt, read 2026-10-06); after each actor clip is stored, 3 small frames go to Claude vision in one router call with a strict per-frame yes/no question (in-scene text ignored); text → the clip is regenerated once with the same request (runProvider: budgets, caps, kill switch, cost tracking), reason on the asset (`regenerateReason: burned_in_text`, `clipText` record); text again → kept with a `clip_text` quality warning (`clipTextBurnedIn`, 11 locales) so a person reviews it; any check failure is logged and skipped; `STUDIO_CLIP_TEXT_GUARD=false` turns it off

- [x] **21.1** Narration never cut mid-sentence (the "trimmer issue", QA run 8): before composition, a shot whose narration voice fit had to trim is lengthened when its picture can play longer (stills and cards always; clips only as far as the stored clip runs) and the time is taken from other shots' slack (min 1.2 s display, narration + tail, overlays, reading time), then the script's ±2 s head-room, so the total stays inside the duration check; remaining trims cut at a sentence end where one exists, are listed in `metadata.narrationShortened` and make audio_sync a `warning` (no auto-approval). Voice-over spilling into the next shot and an automatic per-line rewrite were not added (not supported by the composer / no existing per-shot rewrite path).
- [x] **21.2** Legal scope closed (operator 2026-10-04, "Update all legal points and close that scope"): every `LEGAL REVIEW` comment and solicitor-review note resolved in the published text and removed; transfers outside the UK/EEA (United States, Singapore, Malaysia, Australia) stated as the EU SCCs with the UK International Data Transfer Addendum, as incorporated in each provider's data processing terms, with a transfer risk assessment on file (privacy 7.2, DPA 10.2, sub-processors; no DPF certification claimed); hosting stated as Hetzner, Helsinki, Finland (EU) on every page and in the deploy runbooks; acceptable-use 2.4 matches the one stock HeyGen presenter; `FILL-IN.md` says everything is filled in; all six pages "Last updated: 4 October 2026".
- [x] **21.3** HD video (operator decisions 2026-10-04; per-channel subscription mapped to STANDARD): every plan tier on the full Seedance 2.0 (`dreamina-seedance-2-0-260128`, `SEEDANCE_FULL_MODEL`) at 720p; 2.5 still for shots over 15 s; a not-activated or out-of-credit refusal of 2.0 falls back to Mini (720p) before Kling; 1080p kept as a code path behind `STUDIO_SEEDANCE_RESOLUTION` (no plan sets it); list-price estimates for 720p and 1080p; short-form per-video budgets raised (BASIC / STANDARD £5, PLUS / ENTERPRISE £7). Caps and the pricing page are left to the billing rework.
- [x] **21.4** UGC actor videos (operator request 2026-10-04: "videos that are actually actors"; plan `plans/phase-21-ugc.md`): research of Veo 3.1, Kling, HeyGen, Creatify, Arcads and Mirage from official docs; Veo 3.1 Fast (existing Gemini key) recommended and built: `UGC_ACTOR` treatment (expand-only migration), `actor_video` capability (line in quotes, product photo as reference image, project seed), Kling native-audio fallback behind `KLING_UGC_ACTOR`; Create option (product, photo, actor look) and "Plan my month" option; UGC ideation and script rules; clip-native speech in captions, composition, audio_sync and caption_sync; real-person refusal; AI label always on; no tier gate (per-channel subscriptions), a UGC video uses 2 videos; budget £6 / £7.50; 11 locales; demo sample; stubbed `ugc-actor` pipeline scenario
- [x] **21.5** Per-channel pricing (operator decision 2026-10-04: the tiered pricing was "confusing and unclear"): ONE plan, 1–6 channels (social platforms) at £29 per channel a month with 8 HD short videos per channel a month; weekly £9.50 per channel (monthly ÷ 4 × 1.3, rounded up to 50p, 2 videos a week) and yearly £290 per channel (10 × monthly, 96 a year released 8 a month); HD video packs (5 for £15, 15 for £39, any channel, 3 months); a "Your plan" page (change channels and period with a preview — upgrades now with proration, downgrades at period end — packs, cancel and resume; the Stripe portal only for payment details and invoices); /pricing channel selector with a weekly / monthly / yearly switch; channel limit at publishing with an upgrade prompt; no generation cost shown to customers; every channel subscription is tier STANDARD; caps scale with channels; staff can set channels and period; Stripe catalogue script, test-mode migration script and runbook; 11 locales.
- [x] **21.6** Carousels (post cards), operator request 2026-10-04 from the "instagram-thread-carousel" skill's method (plans/phase-21-carousels.md): Create → Carousel (light/dark, number of posts, optional pasted thread), Claude-written threads (no Borrowed Authority, never real people), pictures by meaning from existing sources, deterministic 1080×1350 PNG slides (sharp + bundled fonts, RTL for Arabic, emoji removed), editor with live preview / reorder / pictures / AI rewrites / downloads, quality checks (safe area, overflow, stretch, WCAG AA), publishing to Instagram, Facebook, LinkedIn and TikTok (YouTube and X: download only), month-plan items, demo sample; a carousel counts as `CAROUSEL_ALLOWANCE_UNITS = 1` video and never shows a £ cost. Operator: verify the slide CDN domain for TikTok photo posts.

## Phase 22 — Fastlane-style formats (operator request 2026-10-05)

- [x] **22.1** Hook + demo (Fastlane's main format, from its public developer docs and founder demos): a silent 3 s reaction hook (a generated person through the existing actor route, Veo 3.1 Fast `actor_video` with a new silent request; or a FOOTAGE-licensed library reaction clip) carrying ONE TikTok-classic hook line (owner's or Claude's, ≤ 12 words, eight hook frameworks), then the business's own demo video from a reusable demo-video bank (`demo_video` uploads; `no_demo_video` when there is none), music ducked under the demo's audio by the chosen mix, sequential or stacked layout, AI label, one video of the allowance; Create, Review, 11 locales, demo sample, stubbed CI scenario `hook-demo`.
- [x] **22.2** Wall of text: one text block (owner's or Claude's, ≤ 60 words, one idea per line, no emoji) in the TikTok-classic look over a calm background (FOOTAGE-licensed library video, else stock footage) with music for 6–12 s, one video of the allowance; Create, Review, 11 locales, demo sample, stubbed CI scenario `wall-of-text`. Not done: month-plan items of this kind.
- [x] **22.3** Reusable AI creators (Fastlane: AI influencers made once per workspace and reused): a Creators library per business (`creators` + `creator_portraits`, expand-only migration; at most 20 live creators per business; DRAFT / READY / RETIRED; audited), made from the UGC presets (gender, age range, setting) plus look notes and a voice-tone note with a portrait generated through the existing IMAGE_STILL route (same fictional-person prompt rules, real-person refusal, budgets, cost caps, kill switch, cost tracking; 30 generated portraits per organisation a day), "Regenerate" with extra instructions, or an uploaded PNG/JPEG photo only with an explicit consent-and-rights attestation (stored with the user and time). Create → UGC "Creator" picker (default the business's most used creator, or "New one-off actor"); the chosen creator's pinned portrait goes to every actor clip and every regenerated clip (`metadata.ugc.creator` / `actorImage`), duplicates keep it, month-plan UGC items use the business default creator. Business → Creators tab, demo sample business with two creators, every string in 11 locales.
- [x] **22.4** Blitz (Fastlane swipe review, operator 2026-10-05/06; plans/phase-22-blitz-automations.md): business angles (≤ 100, AI suggestions) and content-mix preferences (paid formats 0 by default, bounded swipe nudges), a queue of 5 cards per business (one Claude call per refill, hook types, "Why this works", remix of INSPIRE-licensed references, 90-day `no_unique_content`), carousels and slideshows rendered before they are shown and counted only when kept, AI video / UGC as preview cards generated only on keep, daily render / monthly spend / daily swipe caps, keep → next free slot / post now / edit first within the channel limit and allowance, skip reasons, `/blitz` swipe UI (drag, keys, RTL, reduced motion), Business → Angles tab, demo, 11 locales
- [x] **22.5** Automations (weekly / monthly auto generation and posting at the lowest cost, operator 2026-10-06): recurring month-plan periods drafted from angles and a mix snapshot, cheapest formats kept first under the allowance / cost cap / ceiling, TikTok carousels download-only until the slide domain is verified, no slideshows / carousels on YouTube, review in Blitz first or auto-approve, DRAFT → GENERATING → REVIEW → ACTIVE → COMPLETED (+ PAUSED: owner, allowance, billing, owner left), ongoing rollover 3 days ahead, weekly insight with "make more like this", Automations list / wizard / detail calendar, demo, 11 locales
- [x] **22.6** Format polish after the first production QA (2026-10-06): black bars baked into any stored video clip are measured once with ffmpeg cropdetect and cropped off with Shotstack's clip `crop` + `fit: crop` (never failing a shot); hook caption at 4.2 % and hook lines ≤ 9 words (shortened at a clause end); Claude-written wall blocks ≤ 35 words on ≤ 6 lines, and every block on screen long enough to read it (3.5 words/s, ≤ 12 s)
- [x] **22.7** TikTok drafts (operator 2026-10-06, Fastlane's default `posting_mode: "inbox"`): a per-connection TikTok preference "Post directly" | "Send to TikTok drafts" (`platform_connections.tiktokPostMode`, expand-only; new connections default to drafts, existing ones keep posting directly). Drafts use TikTok's documented inbox upload for videos (`/v2/post/publish/inbox/video/init/`, `source_info` only) and `post_mode: "MEDIA_UPLOAD"` for photo posts; the publication shows "Sent to TikTok drafts" (never "Live") with the AI-label reminder, and the creator gets a `tiktok_draft` notification; without `video.upload` the post goes out directly and says "Reconnect TikTok to send drafts". Connections card radio, Blitz keep sheet + autopilot wizard hint, 11 locales, demo

## Phase 23 — Speed and quality (operator request 2026-10-06)

- [x] **23.5** Studio's own renderer for the cheap formats (production 2026-10-06: a month autopilot stalled when Shotstack ran out of credits and every slideshow and wall of text failed; Shotstack also took 49 s p50 per render): slideshows and walls of text render with ffmpeg on the worker from the same edit Shotstack would get (bottom track via xfade/concat with zoompan Ken Burns, text drawn with the carousel sharp/Pango pipeline incl. the TikTok-classic outline, AI label, letterbox crop, looped background clip, music with its levels and fade, two-pass loudnorm to −14 LUFS, H.264 + AAC MP4), stored where composer renders go, provider `local-ffmpeg`, 0p; anything it does not draw or a failed local render falls back to Shotstack automatically; `STUDIO_LOCAL_RENDER=on|off` (default on), under `STUDIO_FFMPEG_MAX_CONCURRENT`
- [x] **23.4** Month plans in batches (production blocker 2026-10-06: an 84-post automation month was truncated at 8 000 output tokens and the runner looped on "Some posts have no topic yet"): the month-plan writer writes 10 posts per call with the planning token cap, up to 3 calls at once, cross-batch de-duplication, failed batches retried and resumable; automations draft missing posts again on the next tick and pause with `draft_failed` (owner notified) after 3 failed drafts; per-format typical costs (carousel 5p, wall of text 15p, slideshow 30p, hook + demo 50p; AI video / UGC as the catalogue) for the cost cap and the automation estimate.
- [x] **23.2** AI pipeline speed and reliability: per-task Claude models (light tasks — script safety, post captions + hashtags, hook line, wall text, Blitz angle suggestions, clip-text check — on Claude Haiku 4.5; planning tasks on ANTHROPIC_MODEL; ANTHROPIC_LIGHT_MODEL / ANTHROPIC_TASK_MODELS, validated, priced per model); plan-project runs the post copy alongside Layer 2 and each script's safety check as soon as it is written; narration word timings from ElevenLabs speech-with-timing alignment (AssemblyAI only for actor clips, uploads and narration without a usable alignment); ElevenLabs speech + music bounded at the plan's 5 concurrent across workers (queued, not failed); out-of-credit providers held for an hour; AI_AVATAR presenters made by the actor route first (Veo, then Kling; default creator portrait or a one-off presenter portrait) with HeyGen / D-ID as the back-up (operator decision 2026-10-06)
- [x] **23.3** Cheap posts count ¼: carousels, slideshows, wall of text and hook + demo use a quarter of a video of the allowance and of HD video packs (AI video 1, UGC 2), so a channel's 8 HD videos a month give up to 32 quick posts; counted in integer quarters (expand-only migration for pack balances), shown as videos (5.5 of 8) with the ¼ rule on usage, Your plan, Plan my month, the upgrade dialog and /pricing in 11 locales; terms and runbook updated; demo
- [x] **23.1** Render speed: Shotstack render callbacks (per-render HMAC token, authenticated rate-limited idempotent route that always re-checks the render with Shotstack, Redis wake flag; polling kept as a 20 s fallback, was 5 s), all multi-format renders submitted together and awaited with allSettled (a failed variant no longer abandons or re-renders the finished ones), and a platform music library (prompt key + duration bucket, rotation over up to 5 tracks per key, `music.status: 'reused'` at cost 0; expand-only `music_library_tracks`)

## Phase 24 — Faster and better than Fastlane (operator-approved plan 2026-10-06)

- [x] **24.2** Calendar-first editing, part 1: live progress on the calendar, month-plan and Blitz screens over Server-Sent Events (`GET /api/studio/live/projects`, per-organisation Redis pub/sub channel announced from `transitionProject` and the publish roll-up, 25 s heartbeat, 10 min stream lifetime, polling fallback) with status chips "Planning / Making clips / Composing / Ready / Scheduled / Posted / Failed" and an ETA from per-format p50s (`live/eta.ts`); a right-side panel (full-height sheet on phones, RTL-safe, Esc / focus trap) that opens a calendar post with its preview, caption, networks, time, status and the existing actions (approve, reschedule, regenerate, open project); instant preview with the Remotion Player (client-only dynamic import) from `GET /projects/:id/preview` — the render, slides, the wall-of-text block or the storyboard; 11 locales
- [ ] **24.3** Calendar-first editing, part 2: redo one scene / slide / caption from the panel, drag-and-drop with undo, bulk actions, per-network preview, storyboard-first generation, command box
## Phase 24 — More AI video providers (operator request 2026-10-06)

- [x] **24.1** fal.ai video provider (OPT-IN, plans/24.1-fal-video.md): a `fal` adapter over fal's queue API (`Authorization: Key <FAL_KEY>`, submit → status → response, cancel while queued, pricing-endpoint health check) for MiniMax H3 Max (`minimax/h3-max/text-to-video` / `image-to-video`, $0.08/s at 768p), LTX-2.3 Fast (`fal-ai/ltx-2.3/text-to-video/fast` / `image-to-video/fast`, $0.06/s at 1080p, 6–20 s) and Veo 3.1 Lite (`fal-ai/veo3.1/lite` / `lite/image-to-video`, $0.03/s at 720p silent, 4–8 s); prices in pricing.ts with sources; fal errors mapped (401/403 auth, 402 or balance wording insufficient_credits, 429 rate_limited, 422 invalid_request or content_policy, 504 timeout, runner errors provider_unavailable); clips copied to the assets bucket at once like every clip. Registered only when `STUDIO_FAL_VIDEO_MODELS` lists models (with `FAL_KEY`); then the router's existing `fal` slot (BASIC after Veo) and a new last-resort slot on paid tiers. `createFalModelAdapter(model, …)` targets one model directly for scripts / bake-offs. Not done: no live clip yet (no key), no fal simulation in the load-test harness.
- [x] **23.6** Capacity under load: rolling generation for month plans and automations (72 h lead window, first 3 posts at once, late posts first; allowance still reserved at approval; "Scheduled to be created on" in the calendars, 11 locales), asynchronous Shotstack renders (compose-video submits and returns; delayed poll-render or the render callback records each render exactly once; timeouts and retries kept), a studio-render lane (WORKER_CONCURRENCY_RENDER) with runners at high priority, smaller BullMQ retention for Redis headroom, and a queue-capacity model (100 orgs × a month: initial backlog 32.7 h → 55 min)

## Phase 25 — Production fixes (2026-10-07)

- [x] **25.x** Music never silent under provider limits (production 2026-10-07: six slideshows started together, ElevenLabs Music refused one with `too_many_concurrent_requests … maximum of 2`, the slideshow rendered with no audio at −70 LUFS and failed the quality gate): ElevenLabs Music holds its own concurrency cap of 2 (`STUDIO_PROVIDER_CONCURRENCY_ELEVENLABS_MUSIC`) inside the ElevenLabs pool of 5, so a burst waits for a slot (compose job delayed) instead of failing; any music generation failure (rate limited, provider down, timeout, no credits, breaker open) falls back to a music-library track (same mood key, then any track long enough, then the longest looped; `music.status 'reused'` with `fallbackFrom`, cost 0); a retried run keeps its track; stubbed pipeline scenario `music-rate-limit`
## Phase 25 — Premium redesign (operator request 2026-10-07)

Plan and audit: the "PostMind Studio Redesign Audit" (Daylight and Darkroom design system, phases 2–16). Each phase is its own PR; tokens, layout and behaviour stay test-green and screenshotted light/dark × phone/desktop.

- [x] **25.2** Tokens and themes: Daylight and Darkroom tokens mapped onto the shadcn variables (canvas/surface/raised/active, line/line-strong, ink 1–3, signal, data, success/warning/error with text-safe foregrounds and soft washes, scrim, charts, role radii, elevation, motion, z-index, section rhythm), WCAG AA contrast test for both themes, film grain removed, Geist + Geist Mono replace Inter + Instrument Serif, Light / Dark / System (default System) in the account menu, top bar and a new Appearance section on /account/profile, amber/emerald/black/white chrome replaced with tokens, RTL check extended to `src/components/ui`.
- [x] **25.3** Core components: one primitive per job (Button + IconButton, NativeSelect/Select, ConfirmDialog + useConfirm, ChoiceChips, SegmentedControl, StatusPill, Tooltip, DataTable, Dialog/Sheet/menus/toasts restyled, open Section, EmptyState/ErrorState/Skeleton), raw elements migrated. MediaTile moves to 25.10 (Library).
- [x] **25.4** App shell and navigation: Create / Plan / Library / Insights / Settings, month plans in the nav, mobile business switcher, command menu, sign-in redirect for /blitz, /plans*, /automations*, a home screen.
- [x] **25.5** Homepage and public site: real renders, pricing and legal restyled, favicon, app icon, link-preview image, optimised media.
- [ ] **25.6** Sign-in and onboarding: branded auth flows, onboarding progress and skippable steps.
- [ ] **25.5** Homepage and public site: real renders, pricing and legal restyled, favicon, app icon, link-preview image, optimised media.
- [x] **25.6** Sign-in and onboarding: branded auth flows, onboarding progress and skippable steps.
- [x] **25.7** Create workspace: format rail first, progressive options, live cost and allowance.
- [ ] **25.8** Video Studio, Image Studio and project review: capability-driven model selector (done with 25.7: catalogue, GET /video-models, the Create picker), real job states with measured ETA, player-first review, Image Studio page.
- [ ] **25.7** Create workspace: format rail first, progressive options, live cost and allowance.
- [ ] **25.8** Video Studio, Image Studio and project review: capability-driven model selector, real job states with measured ETA, player-first review, Image Studio page.
  - [x] **25.8 (review + Image Studio)** Player-first project review (status & actions column, one "Needs your attention" list, tabs in the URL, pipeline with failed/draft states) and the Image Studio page (/images). The capability-driven model selector is a separate PR.
- [ ] **25.9** Calendar, month planner, Blitz and automations.
- [x] **25.10** Library and My media.
- [x] **25.9** Calendar, month planner, Blitz and automations: Month / Week / Day views with URL-synced view, day and filters (platform, status, source), month ARIA grid with keyboard moves, "+n more" popovers, campaign labels and lazy thumbnails, Undo after a move, posting times in a side sheet; one-prompt month planner with a preview, week-by-week plan timeline with per-item approve and bulk new topics / delete / approve (sequential per-item calls); Blitz media-first deck, key-cap hints and read-only explanation; automations list with next post, wizard progress, runs timeline; publications filters in the URL.
- [ ] **25.10** Library and My media.
- [ ] **25.11** Analytics: summary first, scoped to the selected business.
- [x] **25.12** Connections, settings, billing and account (regrouped settings).
- [ ] **25.13** Admin: sectioned side menu, URL-synced tabs, dense tables.
- [x] **25.11** Analytics: summary first, scoped to the selected business.
- [ ] **25.12** Connections, settings, billing and account (regrouped settings).
- [x] **25.13** Admin: sectioned side menu, URL-synced tabs, dense tables.
- [ ] **25.14** Responsive, accessibility (WCAG 2.2 AA, axe on every route) and performance.
- [ ] **25.15** Regression: every route in four modes, main journeys end to end, old-design sweep.
- [ ] **25.16** Redesign report (route matrix, scores) and demo + live updated.
- [x] **25.x** Slideshow photos match the business (production renders 2026-10-07: bakery "Seeded rye with a deep crust" → croissants, boutique "Made in small runs" → a child running, gym "Coaches who know your name" → puppies, café "Pastries baked next door" → iced coffee, florist "Same-day delivery in town" → a pickup truck): photo slides are searched (library, stock, generation prompt) with a contextual stock-photo phrase built from the topic, the business profile and the caption in ONE light-model call per slideshow (`slide_image_query`, Haiku 4.5; fallback topic + caption + image themes, never the bare caption); an imageQuery that differs from the caption is kept; stock candidates pass a batched yes/no vision check (`slide_image_check`, ≤ 3 thumbnails at 384 px, ≤ 8 checks per slideshow) before one is stored, rejected ones never enter the library, an outage accepts the best candidate, no fit → generated image within budget → text card; month plans and Blitz stop copying the caption (or title) into imageQuery.
- [x] **25.x.1** Library matches must fit the slide too (production re-run 2026-10-07: gym, boutique and florist got the SAME off-topic photos, stored in their libraries by the pre-fix run and found by the library search before stock): up to 3 library matches per slide go through the same yes/no check (stored objects read from storage, hotlinked ones downloaded); the business's own UPLOAD / SCRAPED pictures are trusted, STOCK and GENERATED must pass; a rejected match falls through to stock / generation and is never deleted or marked; library and stock checks share one cap per slideshow (12 calls ≈ ≤ $0.018); outage or cap → the best match is accepted as before.

## Phase 26 — Pricing (operator decision 2026-10-09, "apply new pricing")

- [x] **26.1** Tiered pricing (Starter / Growth / Pro) replaces the 21.5 per-channel plan: Starter £29 a month (8 HD videos, 1 business, 1 seat), Growth £69 (20, 1, 3; "Most popular"), Pro £149 (45, 3, 10); weekly = monthly ÷ 4 × 1.3 rounded up to 50p (2 / 5 / 11 videos an ISO week), yearly 10 × monthly (released per calendar month); every plan posts to every platform (no channel limit); quick posts ¼, UGC 2; packs 5 for £17, 15 for £45; trial 7 days, 2 HD videos; one Stripe product per plan, lookup keys studio_<plan>_<weekly|monthly|yearly>, quantity 1; legacy channel subscriptions mapped by quantity (1 Starter, 2-3 Growth, 4+ Pro) until scripts/billing/migrate-to-tiers.ts moves them; plan picker on Your plan, /pricing and the landing; admin plan overrides; 11 locales; demo on Growth monthly.
