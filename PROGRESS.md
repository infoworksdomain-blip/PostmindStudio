# PROGRESS.md — PostMind Studio Build Log

One line per completed backlog item. Newest at the top.

**Format:** `[YYYY-MM-DD] [phase.item] Short description of what was done.`

---

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
