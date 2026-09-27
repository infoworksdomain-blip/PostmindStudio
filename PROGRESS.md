# PROGRESS.md — PostMind Studio Build Log

One line per completed backlog item. Newest at the top.

**Format:** `[YYYY-MM-DD] [phase.item] Short description of what was done.`

---

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
