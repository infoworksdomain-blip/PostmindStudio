# PROGRESS.md — PostMind Studio Build Log

One line per completed backlog item. Newest at the top.

**Format:** `[YYYY-MM-DD] [phase.item] Short description of what was done.`

---

[2026-09-27] [GATE 4] Passed on automated evidence (autonomous build mode): every route integration-tested on real Postgres; CI green on PR #5. Live curl walkthrough (README) pending a Core-issued JWT.

**Phase 4 status: API built; every route integration-tested through the real wrapper on real Postgres (happy/401/403/404/validation/conflict).**

[2026-09-27] [4.10] test/api: 27 route integration tests (projects, scripts, shots, renders, force-approve, idempotency, tenant isolation).
[2026-09-27] [4.9] GET /projects/:id/scripts, GET /scripts/:id, GET|PATCH /shots/:id (narration edit → voice-only regeneration), POST /shots/:id/regenerate (prompt + preferred provider, tier-gated).
[2026-09-27] [4.8] POST /projects/:id/reject (note required; ApprovalTask REJECTED).
[2026-09-27] [4.7] POST /projects/:id/approve (READY_FOR_REVIEW → APPROVED; ApprovalTask APPROVED). Publish enqueue arrives with Phase 5.
[2026-09-27] [4.6] POST /projects/:id/cancel: run superseded, RUNNING provider jobs cancelled, cost incurred reported.
[2026-09-27] [4.5] POST /projects/:id/generate: new runId, QUEUED, plan-project enqueued at the tenant's plan-tier priority.
[2026-09-27] [4.1–4.4] POST/GET /projects (cursor pagination, state/business/days filters), GET/PATCH/DELETE /projects/:id, POST /projects/:id/duplicate.
[2026-09-27] [4.x] Renders: GET /projects/:id/renders, GET /renders/:id, /preview (signed 1h), /download (signed 15m, studio:render:download, audited), POST /renders/:id/force-approve (spec 13.5; content-safety BLOCK refused). GET /api/health (liveness).
[2026-09-27] [4.x] withStudioRoute: tenant → capability → handler; correlation id; Engagement error envelope; Idempotency-Key replay (Redis, 24h); BigInt-safe JSON; audit on every mutation.

**Phase 4 security review — fixed:** Idempotency-Key now reserve-then-execute (SET NX before the handler; concurrent duplicates get 409, never a second execution; key released on failure) and bound to a request-body hash (422 on reuse with a different body); archive write scoped by organisationId; approve/reject moved to a new `studio:project:approve` capability so editors can't self-approve (Core must grant it to reviewers).

**Phase 4 review list:**
- businessId is accepted as given: Core's context contract (assumed) carries no business list, so Studio cannot verify the business belongs to the organisation (spec 7.14 expects Core-side validation).
- Plan tier comes from Core context `organisation.planTier`; unknown/missing → BASIC routing.
- REQUIRE_APPROVAL_FROM_ROLE and multi-step approval workflows are stored but not enforced yet (single-step approve/reject recorded as ApprovalTask).
- Preview/download URLs are S3 presigned URLs; CloudFront signed URLs (CDN_URL) not wired yet.
- No request rate limiting yet (planned with hardening, Phase 12).
- Script PATCH / script regenerate / render rerender (spec 8.3–8.4) not built: shot-level edit/regenerate covers the backlog items.

[2026-09-27] [GATE 3] Passed on automated evidence (autonomous build mode): full pipeline verified on real Postgres + BullMQ/Redis 7 + ffmpeg in CI with scripted providers. Live-provider run (`npm run gate3`) still to be done by the operator with staging keys.

**Phase 3 status: built and verified end-to-end with scripted providers on real Postgres (locally via PGlite, in CI on pgvector Postgres + Redis 7 + ffmpeg). Live-provider run = `npm run gate3`.**

[2026-09-27] [3.10] scripts/worker.ts (`npm run worker [queue…]`, graceful shutdown) + scripts/run-test-project.ts (`npm run gate3`, inline or `--queue`).
[2026-09-27] [3.9] Retry policy: 6 attempts (5 retries), backoff 5s→10s→20s→40s→80s→cap 120s; non-retryable errors → UnrecoverableError; failed jobs kept (removeOnFail:false = dead-letter, operator action).
[2026-09-27] [3.8] workers/runtime.ts: kill switch checked at every job start; final-attempt failure handlers mark shot/project FAILED; runId on every job makes stale/superseded jobs no-ops; state transitions are compare-and-set.
[2026-09-27] [3.7] run-quality-gate: ffprobe/blackdetect/ebur128 + Hive scan → spec 13.1 checks (duration ±2s, black >500ms, LUFS −18..−10, aspect, H.264/MP4, content safety BLOCK vs REVIEW); not-yet-built checks recorded as not_run, never passed.
[2026-09-27] [3.6] compose-video: Shotstack edit list (video/image/html/audio assets), render per script, copy to renders bucket, probe, video_renders row, idempotent per script.
[2026-09-27] [3.5] generate-asset: AI_CLIP (text_to_video) / IMAGE_STILL / TEXT_CARD + per-shot narration (brand voice → ELEVENLABS_DEFAULT_VOICE_ID); outputs copied to S3, video_assets rows, providerRouting snapshot; fan-in enqueues compose once (deterministic jobId).
[2026-09-27] [3.4] plan-project: Layer 1 ideation (vague → DRAFT + 3 directions; restricted topics → DRAFT pending confirmation), Layer 2 script per target format (treatments limited to configured providers, durations fitted to target), pre-generation script safety (BLOCK/REVIEW stop the run), persistence, fan-out.
[2026-09-27] [3.1–3.3] redis.ts (DB 3 enforced), queues.ts (5 spec queues, job payloads, priorities high/normal/low by tier), enqueue.ts (BullMQ + InlineJobQueue behind one JobQueue interface).
[2026-09-27] [3.x] HiveAdapter (V2 sync task API, ≤90s) for Layer 8 content safety.

**Phase 3 review list:**
- Hive async moderation needs a public callback URL (Phase 4 API) — videos >90s currently FAIL the content-safety check (fail-closed) until then. Long-form (YouTube 4–8 min) cannot reach READY_FOR_REVIEW yet.
- Music (Layer 5): no Suno/MusicGen/Storyblocks adapter exists; renders have narration only and project.metadata.music records "skipped". Suno has no documented public API — needs a provider decision.
- Voice runs inside the per-shot asset job (not a separate parallel job as in spec 4.5 step 5); shots still run in parallel with each other.
- Treatments offered to Layer 2 = configured providers + TEXT_CARD. STOCK_FOOTAGE, AI_AVATAR, MOTION_GRAPHICS, USER_UPLOAD are unavailable until their adapters/flows exist.
- Script-safety REVIEW stops the run (no human review queue yet; fail closed).
- Codec check requires H.264 in MP4 but not the Baseline profile the spec names; Shotstack output profile is recorded in the check detail. Enforcing Baseline would fail every render until a re-encode step exists.
- Loudness is not normalised by the pipeline; renders outside −18..−10 LUFS go to QUALITY_FAILED (force-approvable).
- Text cards/captions use Shotstack's `html` asset (documented, deprecated in favour of rich-text); Phase 8 overlay translator replaces it.
- Local dev DB without Docker: `npm run db:local` (PGlite + pgvector); DATABASE_URL needs `&pgbouncer=true`.

[2026-09-27] [GATE 2] Operator approved. Live `npm run gate2:*` results were not shared with the build session, so live provider behaviour is still unverified from this side. CI green on PR #3.

**Phase 2 status: code-complete and unit/integration tested against the providers' DOCUMENTED contracts. NOT yet run against live APIs** (no `.env.local` or database on the build machine). GATE 2 = run `npm run gate2:*` with staging keys.

[2026-09-27] [2.11] tracked.ts: submitTracked/pollTracked/cancelTracked. Kill switch (provider scope) before every submit; provider_jobs PENDING→RUNNING→SUCCEEDED/FAILED/TIMED_OUT/CANCELLED; provider_usage daily upsert; video_projects.costActualPence tally; breaker fed (client-side errors excluded). CI runs test/db against real Postgres.
[2026-09-27] [2.10] circuit-breaker.ts: 5 failures / 60s → open 5 min → half-open single trial. Per-process (Redis-backed state planned with 3.1).
[2026-09-27] [2.9] router.ts: spec 6.4 AI_CLIP/AI_AVATAR lists + 6.5 primary/fallback pairs; skips not_configured / capability_unsupported / provider_disabled / over_budget / too_slow / circuit_open; returns decision snapshot for video_shots.providerRouting; NO_PROVIDER_AVAILABLE with reasons. budget.ts: project hard cap + optional org×provider daily cap.
[2026-09-27] [2.8] shotstack.ts: POST /render, GET /render/{id}; stage|v1 environments. Shotstack documents no cancel endpoint (cancel is a logged no-op) and no per-second price (spec £0.02/s used).
[2026-09-27] [2.7] elevenlabs.ts: POST /v1/text-to-speech/{voice_id}, MP3 to S3 (storage.ts), cost from `character-cost` header.
[2026-09-27] [2.6] runway.ts: gen4.5 text-to-video, gen4_turbo image-to-video, X-Runway-Version 2024-11-06, failureCode classification, cost from task credits.
[2026-09-27] [2.5] openai.ts: gpt-image-2 (b64 → S3) + text-embedding-3-large @ 1536 dims.
[2026-09-27] [2.4] anthropic.ts: claude-sonnet-5 via @anthropic-ai/sdk, structured JSON via output_config.format, exact token cost, refusal/max_tokens handling.
[2026-09-27] [2.3] registry.ts + default-registry.ts: adapters registered only when their API key is set.
[2026-09-27] [2.1–2.2] interface.ts: ProviderAdapter (spec 8.9), capability + request union, ProviderErrorClass.

**Phase 2 security review (independent agent) — all findings fixed:**
- HIGH: cost reserved at submit (estimate → provider_usage + costActualPence), settled to actual at completion, released on failure/cancel. Spend by synchronous providers is visible to caps even if the job is never polled.
- HIGH: router requires `request`; providers without a cost estimator are skipped (`no_cost_estimate`) instead of estimating 0.
- HIGH: half-open trial slot released when the kill switch / DB aborts a submit or the error is client-side; abandoned trials expire after 15 min.
- MEDIUM: pollTracked/cancelTracked take the caller's organisationId; other orgs' jobs return 404.
- MEDIUM: temporary / presigned URLs are redacted before responses are stored in provider_jobs.
- MEDIUM: S3 key segments validated (no '/', '..', leading '.').
- LOW: explicit Anthropic (120s) and OpenAI (180s) SDK timeouts.
- Runway FAILED tasks now report billed credits so charged failures stay counted.

**GATE 2 review list:**
- SPEC DRIFT — DALL-E 3 was removed from OpenAI's API on 2026-05-12. Using `gpt-image-2` (OpenAI's named replacement; `OPENAI_IMAGE_MODEL` to change).
- SPEC DRIFT — Runway "Gen-4 Turbo" is image-to-video only; "Gen-4 Alpha" no longer exists. Text-only clips use `gen4.5` (12 credits/s vs 5); frame-seeded clips use `gen4_turbo`. Runway's API also hosts `veo3.1` (the spec's "Veo 3" for PLUS/ENTERPRISE is only reachable this way or via Vertex AI; `veo3` is gone).
- DEVIATION — ProviderAdapter `output.url` is optional (text/embedding results have no file). Adapters may add optional `estimateCostPence()` / `typicalLatencySec` for the router.
- DECISION — BASIC-plan AI_CLIP shots over 5s use the cheap list (spec 6.4 defines only ≤5s); AI_AVATAR gets D-ID↔HeyGen fallbacks (spec 6.1 "always at least one fallback").
- PRICING TO CONFIRM — ElevenLabs `eleven_multilingual_v2` priced at $0.10/1k chars; FX rate `STUDIO_USD_TO_GBP_RATE` is operator config (placeholder 0.75).
- Anthropic model default changed from `claude-sonnet-4-5` (starter .env.example) to `claude-sonnet-5`, the current Sonnet.
- Only Runway is configured for AI_CLIP today, so after 5 simulated Runway failures the router correctly returns NO_PROVIDER_AVAILABLE for STANDARD shots. A real fallback needs a Luma or Kling adapter (not in the Phase 2 backlog).

[2026-09-27] [GATE 1] Operator approved; the review-list decisions below stand as proposed. JWT alg still unpinned and the pgvector-in-public question is still open for ops. CI green on PR #2.
[2026-09-27] [1.10] kill-switch.ts: four levels (global, workspace, project, provider) from system_flags, 30s per-key cache, fail-closed on unknown values, store errors propagate. Unit + PGlite integration tests (incl. cross-process toggle within the cache window).
[2026-09-27] [1.9] prisma/seed.ts + seedSystemFlags(): kill switch off, 24 providers enabled. Uses createMany skipDuplicates so a re-seed never switches an active kill switch off. `npm run db:seed`.
[2026-09-27] [1.8] Init migration 20260927000000_init_studio_schema generated with `prisma migrate diff --from-empty` (no local Docker). Verified by test/integration/schema.test.ts: all 33 tables land in `studio` and nowhere else; pgvector cosine search works. CI `database` job applies migrations to real pgvector Postgres, seeds twice, and fails on schema/migration drift.
[2026-09-27] [1.7] prisma/schema.prisma: 19 v1.0 + 14 v1.1 tables + 3 A7.2 modifications (33 models). Spec models transcribed verbatim; 4 DERIVED models and 1 DEVIATION marked inline (see GATE 1 review list below).
[2026-09-27] [1.6] audit.ts: fire-and-forget POST (X-Service-Token), 3 attempts with backoff, full entry logged on final failure for replay. Never throws.
[2026-09-27] [1.5] rbac.ts: StudioCapability constants (project read/write, render download/force-approve, admin kill-switch/providers/library/moderation); trailing `:*` grants.
[2026-09-27] [1.4] tenant.ts: jose JWKS verification (24h JWKS cache), iss/aud/exp enforced, Core context fetch (5-min cache, zod-validated), 401/403/502 fail-closed. Tests: happy path, expired, missing, wrong audience/issuer/key, alg none, membership, cache.
[2026-09-27] [1.3] logger.ts: pino with service binding, token/authorization redaction, withContext(), getCorrelationId().
[2026-09-27] [1.2] errors.ts: StudioError hierarchy incl. spec list + UpstreamServiceError, ConfigurationError, NotImplementedError; toErrorResponse() renders the Engagement `{ ok: false, error }` envelope.
[2026-09-27] [1.1] prisma.ts: Engagement-pattern singleton; query logs in development only.

**GATE 1 review list (decisions taken — please confirm or correct):**
- DERIVED `provider_usage`: one row per (organisationId, provider, day) with job/succeeded/failed counts and costPence.
- DERIVED `style_memories`: one row per (org, business, signalType) with 5 signal types from spec 10.3 (hence "1–5 per business"); `reason` field for the 10.4 transparency requirement; soft-delete.
- DERIVED `video_library_categories`: self-referencing tree (slug, name, parentId, depth, sortOrder). Items keep a single `categoryId` as A7.3 specifies, although A3.4 says auto-classification places videos in 1–3 categories. Multi-category needs a join table if wanted.
- DERIVED `video_library_tags`: tag dictionary (name, usageCount). Items keep `tags String[]` per A7.3.
- DEVIATION `image_library.embedding` is nullable (spec: required). A required Unsupported column disables Prisma create(), and images are stored before their embedding exists.
- Kill-switch storage: Engagement keeps workspace freezes on Core's `Organisation`; Studio can't modify Core, so all four levels are system_flags keys (`studio.killSwitch`, `studio.frozenWorkspace.<org>`, `studio.killedProject.<id>`, `studio.disabledProvider.<id>`).
- Core context contract ASSUMED: `GET /api/internal/context/:userId` → `{ organisation: {id, name?, planTier?}, memberships: [{organisationId, role}], capabilities: string[] }`. Validated with zod; any other shape returns 502. JWT user id read from `userId` claim, falling back to `sub`.
- Admin capability names (`studio:admin:kill-switch:read|write`, `:providers`, `:library`, `:moderation`) are Studio-side proposals under the backlog's `studio:admin:*`; Core must grant them.
- tenant.ts KNOWN RISK (security review): capability/membership changes within one org take up to 5 min to apply (spec 16.1 cache). Org switches are re-read from Core immediately. No explicit JWT `algorithms` allow-list yet: please confirm which alg Core signs with (e.g. RS256) and it will be pinned.
- Embeddings are `vector(1536)` per spec; text-embedding-3-large must be called with `dimensions: 1536` (its native size is 3072). Phase 2.5.

[2026-09-27] [GATE 0] Operator approved. CI green on PR #1.
[2026-09-27] [0.9] README: local-development quick reference (install, env, db:up, migrate, dev, test) and script table.
[2026-09-27] [0.8] CI workflow (.github/workflows/ci.yml): npm ci, prisma validate, typecheck, lint, format check, test on Node 20.
[2026-09-27] [0.7] docker-compose.yml: pgvector/pgvector:pg15 + redis:7-alpine with healthchecks; init.sql creates `studio` schema + vector ext; db:reset script.
[2026-09-27] [0.6] Vitest configured (`@` alias, v8 coverage with 80% threshold on src/lib); harness test passes.
[2026-09-27] [0.5] Verified the existing .env.example covers DB, Redis, Core integration, S3/KMS, Meta, platform OAuth, every spec Section 6 provider, queue, observability and feature flags. No changes needed.
[2026-09-27] [0.4] Migration 00000000000000_enable_pgvector: CREATE SCHEMA studio + CREATE EXTENSION vector (idempotent).
[2026-09-27] [0.3] prisma/schema.prisma: datasource schemas = ["studio"], extensions = [vector]. DECISION: `multiSchema` preview flag omitted because it is GA in Prisma 6.19 and the flag now triggers a deprecation warning.
[2026-09-27] [0.2] Core deps installed. DECISION: pinned to newest majors compatible with the spec stack (Next 15.5, TS ~5.9, Prisma 6.19, ESLint 9, Vitest 3, BullMQ 5, ioredis 5, zod 4). Newer majors (TS 7, Prisma 7/8, ESLint 10, BullMQ 6) are out of scope for CLAUDE.md or unsupported by eslint-config-next 15.
[2026-09-27] [0.1] Next.js 15 App Router + strict TypeScript (noUncheckedIndexedAccess) + Prettier + ESLint flat config (no-explicit-any, no-console). Production build passes.

**Open questions:**
- pgvector on the shared cluster: on a cluster without pgvector, migrations install it into `studio` (verified). If PostMind Core has ALREADY installed `vector` in `public`, `CREATE EXTENSION IF NOT EXISTS` is a no-op and the `vector(1536)` columns will not resolve under `search_path=studio`, so the init migration fails loudly. Ops needs to confirm the production cluster's state before first deploy.
- Node version: CLAUDE.md says Node 20 LTS. CI runs 20. This dev machine runs Node 24, which works, but the spec baseline is 20.
