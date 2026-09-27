# CLAUDE.md — PostMind Studio Build Instructions

You are Claude Code building the **PostMind Studio** microservice for **PostMind AI**. Read this file at the start of every session. Read the three specs in `/docs` before making any architectural decision.

## What this project is

PostMind Studio is a new microservice for the PostMind AI platform. It generates short-form and long-form videos using AI providers (Runway, Luma, HeyGen, ElevenLabs, Suno, Shotstack, etc.) and auto-publishes to TikTok, Instagram, YouTube, X, LinkedIn, and Facebook. It also handles slideshows, text-overlay editing, and a 50,000-video reference library.

**The specs are the source of truth. Not your training data. Not your memory of similar projects. The specs.**

- `/docs/PostMind_Studio_Specification.docx` — v1.0 spec (47 pages). Architecture, 9-layer pipeline, providers, database schema, API reference, publishing per platform.
- `/docs/PostMind_Studio_Specification_Addendum_v1.1.docx` — v1.1 additions. Video library, text overlays, slideshows, auto-image sourcing.
- `/docs/PostMind_Studio_PreProduction_Planning_Playbook.docx` — planning context. Read this to understand what has been decided.
- `/docs/PostMind_Engagement_Developer_Handover.docx` — the sibling Engagement microservice. **Studio follows the same architecture pattern.** When in doubt, copy the Engagement pattern.

If you cannot open the .docx files directly, ask the operator to provide the relevant section as text.

## Non-negotiable ground rules

1. **Never modify existing PostMind Core or Engagement code.** Studio is additive. If you think something in PostMind needs changing, stop and ask.
2. **Never invent provider APIs.** If you don't know Runway's or TikTok's actual API shape, search the docs or ask the operator. Do not guess endpoints, parameter names, or response shapes.
3. **Never hardcode credentials.** Every secret goes in `.env.local` (which is git-ignored) and is documented in `.env.example`.
4. **Never fake a working feature.** If an integration point isn't ready, mark it clearly (`throw new NotImplementedError(...)`) rather than returning fake data. Fake data hides bugs.
5. **Never skip tests for code you write.** Every service function gets a unit test. Every API route gets an integration test.
6. **Never delete files in `/docs`.** Ever. They are the specs.
7. **Always check `BACKLOG.md` before starting a task.** The backlog defines what to build in what order. Don't jump ahead.
8. **Always update `PROGRESS.md` when you finish a task.** One line per completed backlog item.
9. **Always ask before starting a new backlog phase.** Phase transitions are decision points for the operator.

## Architecture (from the specs — canonical)

- **Runtime**: Next.js 15 (App Router), Node 20 LTS, TypeScript 5.4+
- **Database**: PostgreSQL 15+ with `pgvector` extension. Studio uses the `studio` schema. Shared cluster with PostMind Core (never modify Core's schema).
- **Queue**: BullMQ over Redis. Shared Redis cluster; Studio uses DB 3.
- **Storage**: S3-compatible object storage. Three buckets: `studio-assets`, `studio-renders`, `studio-thumbnails`. One more for the library: `studio-library-assets`.
- **CDN**: CloudFront (or equivalent) with signed URLs.
- **Auth**: JWT issued by PostMind Core. Studio verifies against PostMind's JWKS endpoint. Never issue tokens itself.
- **Integration points** (four `@/lib/*` modules — same pattern as Engagement):
  - `src/lib/prisma.ts` — Prisma client singleton for the studio schema
  - `src/lib/tenant.ts` — `requireTenantContext(req)` — extracts org/user from JWT, calls PostMind Core for context
  - `src/lib/rbac.ts` — `requireCapability(context, capability)` — enforces per-endpoint permissions
  - `src/lib/audit.ts` — `auditLog(entry)` — fire-and-forget POST to PostMind's audit service

## The 9-layer generation pipeline

Every video goes through the same 9 layers. Do not shortcut them.

1. **Ideation** — brief → concrete IdeationBrief (Claude Sonnet)
2. **Script + storyboard** — brief → per-format scripts with shot lists (Claude Sonnet)
3. **Asset generation** — per shot: Runway / Luma / HeyGen / Storyblocks / DALL-E (via provider router)
4. **Voice** — ElevenLabs (primary), Azure Speech (fallback)
5. **Music + SFX** — Suno (primary), MusicGen (fallback), Storyblocks (library)
6. **Composition** — Shotstack (primary), Creatomate (fallback)
7. **Multi-format render** — one project → outputs for TikTok, Reels, Shorts, LinkedIn, etc.
8. **Quality gate + review** — automated checks + Hive content safety + user approval
9. **Publish + track** — per-platform publisher + analytics polling

Each layer maps to specific service files under `src/lib/studio/`. See the spec's Section 5 for layer detail.

## Provider adapter interface

**Every external provider implements this interface** (defined in `src/lib/studio/providers/interface.ts`). No exceptions.

```typescript
interface ProviderAdapter {
  readonly providerId: string;
  readonly capabilities: ProviderCapability[];
  submit(request: ProviderRequest): Promise<{ providerJobId: string; estimatedCostPence: number; estimatedReadyAt: Date }>;
  poll(providerJobId: string): Promise<{ state: 'running' | 'succeeded' | 'failed'; output?: { url: string; metadata: unknown }; error?: { class: string; message: string; retryable: boolean } }>;
  cancel(providerJobId: string): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; reason?: string }>;
}
```

The provider router (`src/lib/studio/providers/router.ts`) picks a provider per shot based on: `visualTreatment`, plan tier, org preferences, provider health, budget remaining, latency budget.

## Kill switch

Four levels per spec Section 12. All backed by the `system_flags` table (DB-backed, not in-memory). All workers check on job start. Cache TTL 30 seconds. Same pattern Engagement uses.

## Code conventions

- **TypeScript strict mode**. No `any`. No `@ts-ignore` without a comment explaining why.
- **Prisma**: models in `prisma/schema.prisma`. Migrations via `prisma migrate dev` in development. Never edit generated files.
- **API routes**: `src/app/api/studio/...`. Always call `requireTenantContext` first, then `requireCapability`, then execute.
- **Services**: `src/lib/studio/services/*.ts`. Pure functions where possible. No req/res in services.
- **Workers**: `src/lib/studio/queue/workers/*.ts`. One file per job type.
- **Tests**: Vitest. Co-located `.test.ts` next to source. Integration tests in `test/integration/`.
- **Errors**: Use custom error classes from `src/lib/errors.ts`. Never throw plain `Error` in production code.
- **Logging**: Structured logger from `src/lib/logger.ts`. Include correlationId, organisationId, projectId when available.
- **Formatting**: Prettier config in repo. Never commit unformatted code.
- **Commits**: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).

## What not to build yet

- Do not build the video composition rendering itself — Shotstack does that. You build the JSON edit-decision-list and POST it.
- Do not build a video encoder — providers return MP4s; we store and serve them.
- Do not build authentication UI — PostMind Core handles login. Studio only verifies tokens.
- Do not build the payment / billing system — PostMind Core handles billing. Studio reports usage events.
- Do not build the Engagement Meta OAuth flow — reuse the tokens Engagement already has.

## When you need to make a decision

1. Check the specs first.
2. Check the Engagement service pattern (referenced in `/docs`).
3. If still unclear, **stop and ask the operator**. Do not guess on load-bearing decisions like schema design, auth flows, or provider routing logic.

## Session workflow

1. On session start: read this file, read `BACKLOG.md`, read `PROGRESS.md`.
2. Confirm with the operator which backlog item(s) you'll work on.
3. Implement in small commits. Run tests after each commit.
4. When done: update `PROGRESS.md`, mark the backlog item complete, summarize what changed and what to review.
5. Never mark a task complete unless tests pass and you've verified the behavior.

## Provider credentials status

The operator has confirmed all external accounts and API approvals are in place:
- Meta App Review addition — approved
- TikTok Content Posting API — approved
- YouTube Data API quota increase — approved
- LinkedIn Marketing Developer Platform — approved
- X API (Basic tier) — active
- All AI provider accounts (Runway, Luma, HeyGen, ElevenLabs, Suno, Shotstack, AssemblyAI, OpenAI, Anthropic, Hive) — active

Credentials will be in `.env.local` (you don't have write access to it; the operator populates it). `.env.example` documents every variable and where to get it.

## Final note

You are building a production system that touches customer payment methods, publishes to their social accounts, and stores their brand voice. Bugs here are visible to real customers. Slow down where slowness matters (auth, publishing, kill switch, cost controls). Speed up where speed helps (scaffolding, boilerplate, tests). When you don't know, ask.
