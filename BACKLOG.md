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

- [ ] **1.1** Implement `src/lib/prisma.ts` — singleton PrismaClient with dev/prod logging.
- [ ] **1.2** Implement `src/lib/errors.ts` — custom error classes (`UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ValidationError`, `ProviderError`, `KillSwitchTriggeredError`, `RateLimitError`).
- [ ] **1.3** Implement `src/lib/logger.ts` — pino structured logger with correlationId support.
- [ ] **1.4** Implement `src/lib/tenant.ts` — JWKS-verified JWT parsing, PostMind Core context fetch, 5-min cache. Unit tests for happy path, expired token, missing token, wrong audience.
- [ ] **1.5** Implement `src/lib/rbac.ts` — `requireCapability(context, capability)`. Enum of all Studio capabilities (`studio:project:read`, `studio:project:write`, `studio:render:download`, `studio:render:force-approve`, `studio:admin:*`).
- [ ] **1.6** Implement `src/lib/audit.ts` — fire-and-forget POST to PostMind audit service. Never throws.
- [ ] **1.7** Write the full `prisma/schema.prisma` — all v1.0 tables (19) + all v1.1 tables (14 new + 3 modifications). Verify against spec Section 7 and Addendum A7.
- [ ] **1.8** Run `prisma migrate dev --name init_studio_schema`. Verify all tables land in `studio` schema.
- [ ] **1.9** Add `system_flags` seed data (kill switch off, all providers enabled).
- [ ] **1.10** Implement `src/lib/studio/kill-switch.ts` — DB-backed check with 30s in-memory cache. Unit tests for all four levels.
- [ ] **[GATE 1]** Operator reviews schema, confirms it matches spec.

---

## Phase 2 — Provider adapter interface + first providers (target: week 2-3)

- [ ] **2.1** Define `src/lib/studio/providers/interface.ts` — the `ProviderAdapter` interface exactly as spec Section 8.9.
- [ ] **2.2** Define `ProviderRequest`, `ProviderCapability`, `ProviderError` types.
- [ ] **2.3** Implement `src/lib/studio/providers/registry.ts` — registers all adapters, exposes `getAdapter(providerId)` and `getAdaptersByCapability(cap)`.
- [ ] **2.4** Implement `src/lib/studio/providers/anthropic.ts` — Claude adapter for ideation and script capabilities. Use real API. Tests using recorded responses.
- [ ] **2.5** Implement `src/lib/studio/providers/openai.ts` — DALL-E 3 for images + text-embedding-3-large for embeddings.
- [ ] **2.6** Implement `src/lib/studio/providers/runway.ts` — Gen-4 text-to-video. Use real API against staging key.
- [ ] **2.7** Implement `src/lib/studio/providers/elevenlabs.ts` — voice synthesis with brand voice support.
- [ ] **2.8** Implement `src/lib/studio/providers/shotstack.ts` — composition (edit-decision-list POST).
- [ ] **2.9** Implement `src/lib/studio/providers/router.ts` — routing logic per spec Section 6.4. Considers plan tier, health, budget, latency.
- [ ] **2.10** Implement `src/lib/studio/providers/circuit-breaker.ts` — 5 failures in 60s opens for 5 min.
- [ ] **2.11** Add ProviderJob DB writes on every submit/poll/complete. Cost tracking to `provider_usage`.
- [ ] **[GATE 2]** Operator confirms one end-to-end provider call works (submit a Runway generation, poll, retrieve URL).

---

## Phase 3 — Queue + orchestration engine (target: week 3-4)

- [ ] **3.1** Implement `src/lib/studio/queue/redis.ts` — BullMQ Redis connection config (DB 3).
- [ ] **3.2** Define queues in `src/lib/studio/queue/queues.ts`: `studio-orchestration`, `studio-assets`, `studio-publish`, `studio-scheduled`, `studio-analytics`.
- [ ] **3.3** Implement `src/lib/studio/queue/enqueue.ts` — typed helpers to enqueue each job type with priority based on plan tier.
- [ ] **3.4** Implement `src/lib/studio/queue/workers/plan-project.ts` — Layer 1 (Ideation) + Layer 2 (Script + Storyboard). Uses Anthropic adapter. Writes `video_briefs`, `video_scripts`, `video_shots`.
- [ ] **3.5** Implement `src/lib/studio/queue/workers/generate-asset.ts` — Layer 3-5. Routes per `visualTreatment`. Handles voice + music + visuals.
- [ ] **3.6** Implement `src/lib/studio/queue/workers/compose-video.ts` — Layer 6-7. Builds Shotstack EDL, polls to completion, writes `video_renders`.
- [ ] **3.7** Implement `src/lib/studio/queue/workers/run-quality-gate.ts` — Layer 8 auto-checks + Hive content safety.
- [ ] **3.8** Every worker checks kill switch on job start. Every worker updates project state transitions.
- [ ] **3.9** Implement retry logic: 5 retries, exponential backoff 5s → 2min cap. Dead-letter after.
- [ ] **3.10** Add `scripts/worker.ts` entry point for running workers in separate process. Update `package.json` scripts.
- [ ] **[GATE 3]** Operator triggers a test project end-to-end (brief → script → one AI clip generated → composed → quality-checked). Manual for now.

---

## Phase 4 — Project + script + shot APIs (target: week 4-5)

- [ ] **4.1** Implement `POST /api/studio/projects` — create project, validate against spec Section 8.2. Zod schema for body. Auth + capability + audit.
- [ ] **4.2** Implement `GET /api/studio/projects` — list with cursor pagination, filter by state/business/days.
- [ ] **4.3** Implement `GET /api/studio/projects/[id]` — read one with scripts/renders/publications summary.
- [ ] **4.4** Implement `PATCH /api/studio/projects/[id]` — update editable fields.
- [ ] **4.5** Implement `POST /api/studio/projects/[id]/generate` — enqueue `plan-project`.
- [ ] **4.6** Implement `POST /api/studio/projects/[id]/cancel` — cancel in-flight, mark project failed with cost incurred.
- [ ] **4.7** Implement `POST /api/studio/projects/[id]/approve` — advance state, enqueue publish jobs.
- [ ] **4.8** Implement `POST /api/studio/projects/[id]/reject` — halt, require note.
- [ ] **4.9** Implement script/shot endpoints: GET script, PATCH shot, POST shot regenerate.
- [ ] **4.10** Integration tests for each route: happy path + 401 + 403 + 404 + validation error.
- [ ] **[GATE 4]** Operator can POST a project via curl and receive a rendered video URL via GET.

---

## Phase 5 — Platform connections + publishing (target: week 5-7)

- [ ] **5.1** Implement `src/lib/studio/platforms/interface.ts` — `PlatformPublisher` interface (register/upload/publish/status).
- [ ] **5.2** Implement `src/lib/studio/platforms/tiktok.ts` per spec Section 9.2. Real Content Posting API.
- [ ] **5.3** Implement `src/lib/studio/platforms/instagram-reel.ts` per Section 9.3. Reuse Engagement's Meta credentials via internal API.
- [ ] **5.4** Implement `src/lib/studio/platforms/youtube.ts` (Shorts + long-form) per Section 9.4.
- [ ] **5.5** Implement `src/lib/studio/platforms/x.ts` per Section 9.5.
- [ ] **5.6** Implement `src/lib/studio/platforms/linkedin.ts` per Section 9.6.
- [ ] **5.7** Implement `src/lib/studio/platforms/facebook.ts` per Section 9.7.
- [ ] **5.8** OAuth flows: `POST /api/studio/platform-connections/oauth-init`, `GET /api/studio/platform-connections/oauth-callback`. Encrypted token storage via KMS envelope.
- [ ] **5.9** Implement publish worker: fires per-platform publisher, records `video_publications`, calls Engagement's `/internal/publications/attribute-conversation`.
- [ ] **5.10** Implement `POST /api/studio/publications` (schedule or publish now).
- [ ] **5.11** Scheduled publishing via BullMQ delayed jobs.
- [ ] **[GATE 5]** Operator publishes a real video to TikTok + Instagram + YouTube from Studio.

---

## Phase 6 — Feature D: Website scan + image library (v1.1) (target: week 7-8)

- [ ] **6.1** Implement `src/lib/studio/scan/fetch.ts` — respect robots.txt, User-Agent `PostMindStudio/1.0`, 1 req/sec, Playwright fallback for JS-rendered.
- [ ] **6.2** Implement `src/lib/studio/scan/extract.ts` — cheerio HTML parse, meta/OG/JSON-LD/images.
- [ ] **6.3** Implement `src/lib/studio/scan/classify.ts` — Claude Sonnet classification → `BusinessProfile`.
- [ ] **6.4** Implement image library ingestion: scraped-images layer (with stock-hash filter), stock APIs (Pexels + Storyblocks + Unsplash), on-demand DALL-E generation.
- [ ] **6.5** Implement `POST /api/studio/businesses/[id]/scan-website`, related GET/PATCH endpoints per Addendum A6.8.
- [ ] **6.6** Implement image library endpoints (list, get, upload, generate, search, delete, refresh).
- [ ] **6.7** Vector similarity search using pgvector on image embeddings.
- [ ] **[GATE 6]** Operator scans their own website and sees a populated image library.

---

## Phase 7 — Feature C: Slideshow mode (v1.1) (target: week 8-9)

- [ ] **7.1** Extend `VideoProject.sourceType` to include SLIDESHOW. Migration.
- [ ] **7.2** Implement `slideshow_slides` and `slideshow_templates` models (should already exist from Phase 1).
- [ ] **7.3** Implement slide types per Addendum A5.3: IMAGE_STILL, IMAGE_KENBURNS, VIDEO_CLIP, TEXT_CARD, BEFORE_AFTER, QUOTE, STATISTIC, PRODUCT.
- [ ] **7.4** Implement 8 built-in slideshow templates per Addendum A5.4.
- [ ] **7.5** Implement `POST /api/studio/projects/[id]/auto-populate` — pulls from image library.
- [ ] **7.6** Slideshow-specific composition (Shotstack Ken Burns effect, image sequencing).
- [ ] **7.7** All slide CRUD endpoints per Addendum A8.3.
- [ ] **[GATE 7]** Operator creates a listicle slideshow end-to-end from their own image library.

---

## Phase 8 — Feature B: Text overlay engine (v1.1) (target: week 9-11)

- [ ] **8.1** Implement `text_overlays` and `overlay_presets` models (should exist from Phase 1).
- [ ] **8.2** Seed 25 built-in overlay presets per Addendum A4.3 (hook, subtitle, CTA, quote, statistic, story, brand).
- [ ] **8.3** Implement overlay-to-Shotstack translator per Addendum A4.6.
- [ ] **8.4** Implement custom animation renderer for glitch/karaoke/counter via FFmpeg pre-render.
- [ ] **8.5** Auto-suggestion at script time (Layer 2 populates default overlays per shot).
- [ ] **8.6** All overlay CRUD endpoints per Addendum A8.2.
- [ ] **8.7** `POST /api/studio/overlays/[id]/preview` — 3-second preview render.
- [ ] **[GATE 8]** Operator adds a styled hook overlay to an existing project and re-renders.

**NOTE**: The overlay editor UI is the highest-risk UX in the spec (per playbook Workstream F). The backend is straightforward; the frontend editor needs iteration with real users.

---

## Phase 9 — Feature A: Video library + reference-guided generation (v1.1) (target: week 11-14)

**Precondition**: 50k video corpus delivered to `studio-library-assets` S3 bucket with per-item licence metadata.

- [ ] **9.1** Implement `src/lib/studio/library/ingest.ts` — the full ingestion pipeline per Addendum A3.3 (FFmpeg scene detection, transcription, OCR, LLM structural analysis, embedding).
- [ ] **9.2** Run ingestion on 100 sample videos. Operator reviews output. Iterate.
- [ ] **9.3** Full ingestion of 50k videos (parallel workers, monitored).
- [ ] **9.4** Implement `src/lib/studio/library/similarity.ts` — pgvector nearest-neighbour.
- [ ] **9.5** Implement `src/lib/studio/library/blueprint.ts` — TEMPLATE mode blueprint extraction + application.
- [ ] **9.6** All library endpoints per Addendum A8.1.
- [ ] **9.7** Category taxonomy seed data (200 nodes).
- [ ] **9.8** Admin library management UI (staff-only).
- [ ] **[GATE 9]** Operator searches library, picks a reference video, generates a new project in TEMPLATE mode, and the output structurally matches the reference.

---

## Phase 10 — Frontend (create/review/manage screens) (target: week 8-14, parallel with backend)

- [ ] **10.1** Set up Tailwind, shadcn/ui, match PostMind design system tokens.
- [ ] **10.2** Auth wrapper — read JWT from PostMind session cookie or bearer header.
- [ ] **10.3** New Project screen (Create) — the "one text box, one button" experience per Addendum A14.1.
- [ ] **10.4** Review screen with per-variant preview, shot strip, quality panel.
- [ ] **10.5** Manage — projects list, publications list, calendar.
- [ ] **10.6** Analytics dashboard.
- [ ] **10.7** Library browse + detail (Feature A).
- [ ] **10.8** Slideshow builder.
- [ ] **10.9** Business profile + image library screens.
- [ ] **10.10** Overlay editor (highest complexity — see design prototype in `/docs`).
- [ ] **10.11** Admin Centre integration.

---

## Phase 11 — Analytics + observability (target: week 12-14)

- [ ] **11.1** Analytics polling per platform (30s → 5min → 1hr → daily schedule).
- [ ] **11.2** Analytics rollup jobs.
- [ ] **11.3** Analytics endpoints.
- [ ] **11.4** Cost tracking dashboards.
- [ ] **11.5** Prometheus metrics endpoint.
- [ ] **11.6** Sentry integration.
- [ ] **11.7** Health endpoints (`/api/health`, `/api/health/ready`).

---

## Phase 12 — Hardening + launch prep (target: week 14-16)

- [ ] **12.1** Load testing (k6 scripts per Engagement pattern).
- [ ] **12.2** Kill switch rehearsals — all 4 levels, timed against SLO.
- [ ] **12.3** Rollback rehearsal.
- [ ] **12.4** All runbooks written per playbook Section 11.
- [ ] **12.5** Beta customer onboarding (5-10 friendlies).
- [ ] **12.6** Production deployment configs (Dockerfile, docker-compose.prod.yml, deploy runbooks).
- [ ] **12.7** Full end-to-end regression: every user journey in playbook Workstream H golden-path list.
- [ ] **[GATE 12]** Go / No-Go decision per playbook Section 14 → v1.0 GA.
