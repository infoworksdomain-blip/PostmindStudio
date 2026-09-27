# PROGRESS.md — PostMind Studio Build Log

One line per completed backlog item. Newest at the top.

**Format:** `[YYYY-MM-DD] [phase.item] Short description of what was done.`

---

[2026-09-27] [0.9] README: local-development quick reference (install, env, db:up, migrate, dev, test) and script table.
[2026-09-27] [0.8] CI workflow (.github/workflows/ci.yml): npm ci, prisma validate, typecheck, lint, format check, test on Node 20.
[2026-09-27] [0.7] docker-compose.yml: pgvector/pgvector:pg15 + redis:7-alpine with healthchecks; init.sql creates `studio` schema + vector ext; db:reset script.
[2026-09-27] [0.6] Vitest configured (`@` alias, v8 coverage with 80% threshold on src/lib); harness test passes.
[2026-09-27] [0.5] Verified the existing .env.example covers DB, Redis, Core integration, S3/KMS, Meta, platform OAuth, every spec Section 6 provider, queue, observability and feature flags. No changes needed.
[2026-09-27] [0.4] Migration 00000000000000_enable_pgvector: CREATE SCHEMA studio + CREATE EXTENSION vector (idempotent).
[2026-09-27] [0.3] prisma/schema.prisma: datasource schemas = ["studio"], extensions = [vector]. DECISION: `multiSchema` preview flag omitted because it is GA in Prisma 6.19 and the flag now triggers a deprecation warning.
[2026-09-27] [0.2] Core deps installed. DECISION: pinned to newest majors compatible with the spec stack (Next 15.5, TS ~5.9, Prisma 6.19, ESLint 9, Vitest 3, BullMQ 5, ioredis 5, zod 4). Newer majors (TS 7, Prisma 7/8, ESLint 10, BullMQ 6) are out of scope for CLAUDE.md or unsupported by eslint-config-next 15.
[2026-09-27] [0.1] Next.js 15 App Router + strict TypeScript (noUncheckedIndexedAccess) + Prettier + ESLint flat config (no-explicit-any, no-console). Production build passes.

**Open questions for GATE 0 / GATE 1:**
- pgvector on the shared cluster: if PostMind Core already has `vector` installed in `public`, the `studio` search_path won't resolve the type. Decide before 1.7: install into `public` and qualify the columns, or add `public` to the search_path.
- Node version: CLAUDE.md says Node 20 LTS. CI runs 20. This dev machine runs Node 24, which works, but the spec baseline is 20.
