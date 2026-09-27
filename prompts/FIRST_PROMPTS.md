# FIRST_PROMPTS.md — The first 10 prompts to give Claude Code

Paste these into Claude Code one at a time, in order. Wait for Claude Code to complete each before moving to the next. Review the diff before accepting.

**Before you start:**
1. Install Claude Code: https://claude.com/docs/claude-code
2. Open this repo in VS Code
3. From the repo root, run: `claude` (starts Claude Code)
4. Claude Code will automatically read `CLAUDE.md`. Confirm it did.

---

## Prompt 1 — Kickoff and confirmation

```
Read CLAUDE.md, BACKLOG.md, and PROGRESS.md. Confirm that you understand:
1. This is the PostMind Studio microservice for PostMind AI.
2. The specs in /docs are the source of truth.
3. You will work through BACKLOG.md top to bottom.
4. You will not skip phases or gates without my approval.

Once confirmed, list the specific items in Phase 0 that you will work on first. Do not start coding yet.
```

---

## Prompt 2 — Phase 0 kickoff

```
Start Phase 0. Complete items 0.1 through 0.9 in order.

For each item:
- Show me the files you will create before you create them.
- Once I say "go", create them.
- After creating, run the relevant checks (typecheck, tests) to verify.
- Move to the next item.

Do not proceed to Phase 1 until GATE 0 is passed and I confirm.
```

---

## Prompt 3 — Verify Phase 0

```
Show me:
1. `npm run typecheck` output
2. `npm test` output
3. `docker compose up` should work (do not actually start it, just verify the compose file is valid)
4. CI workflow syntax check

If any of these fail, fix them. Then update PROGRESS.md with Phase 0 completion.
```

---

## Prompt 4 — Phase 1: Integration points

```
Start Phase 1, items 1.1 through 1.6 (the four @/lib integration points plus errors and logger).

For each:
- Reference the exact section of the v1.0 spec you are implementing.
- Show the file, the tests, and any type definitions.
- I will review before you continue to the next.

Pay special attention to src/lib/tenant.ts — the JWT verification must match the pattern in the Engagement handover doc. If any behavior is unclear from the spec, ask me before implementing.
```

---

## Prompt 5 — Phase 1: The full Prisma schema

```
Item 1.7. Write the complete prisma/schema.prisma covering:

- All 19 tables from v1.0 spec Section 7 (video_projects, video_briefs, video_scripts, video_shots, video_assets, video_renders, video_publications, video_analytics, provider_jobs, provider_usage, brand_kits, voice_profiles, style_memories, templates, scheduled_publications, platform_connections, approval_workflows, approval_tasks, system_flags)

- All 14 new tables from v1.1 addendum Section A7 (video_library, video_library_categories, video_library_tags, video_library_analysis, video_library_embeddings, video_library_licenses, text_overlays, overlay_presets, slideshow_slides, slideshow_templates, business_profiles, website_scans, image_library, image_library_queries)

- The 3 modifications to existing tables (video_projects extended source types, video_shots overlay relation, brand_kits businessProfileId)

Verify against both spec sections. Use @@schema("studio") on every model. Use pgvector Unsupported type for embedding columns.

Show me the schema before running the migration. Do NOT run `prisma migrate dev` yet — I want to review first.
```

---

## Prompt 6 — Phase 1: Migration and kill switch

```
Once I approve the schema, run prisma migrate dev --name init_studio_schema. Verify all tables land in the studio schema (query pg_tables).

Then complete items 1.9 and 1.10 — seed system_flags data and implement the kill switch service with DB caching and unit tests.

The kill switch must have four levels (global, workspace, project, action type / provider) matching the spec Section 12 and matching the Engagement service's pattern.
```

---

## Prompt 7 — Phase 2: Provider adapter interface + Anthropic

```
Start Phase 2. First, item 2.1 and 2.2 — define the ProviderAdapter interface and supporting types in src/lib/studio/providers/interface.ts. Match spec Section 8.9 exactly.

Then item 2.3 — the provider registry.

Then item 2.4 — the Anthropic adapter. Use the @anthropic-ai/sdk. Implement submit/poll/cancel/healthCheck. The Anthropic API is synchronous, so submit + poll should compose to a single Claude call. Cost tracking via provider_jobs table.

Write vitest tests using recorded API responses. Do not hit the real API in tests.
```

---

## Prompt 8 — Phase 2: First working provider call end-to-end

```
Add a small dev script at scripts/test-anthropic.ts that:
1. Loads env
2. Instantiates the Anthropic adapter
3. Submits an ideation prompt for a hypothetical brief
4. Prints the response
5. Verifies a provider_jobs row was written to the DB

Run it against my staging Anthropic key. Show me the output. This is GATE 2's first real provider call.
```

---

## Prompt 9 — Phase 2: Runway, ElevenLabs, Shotstack adapters

```
Implement items 2.6 (Runway), 2.7 (ElevenLabs), 2.8 (Shotstack) in that order.

For each:
- Read the provider's real API docs. Do not guess endpoints. If the docs are unclear on any behavior, ask me and I will provide.
- Implement the adapter matching the ProviderAdapter interface.
- Runway is async (submit returns a job ID, poll until ready).
- ElevenLabs is mostly synchronous (single POST returns audio bytes).
- Shotstack is async render pipeline.
- Write tests using recorded responses.
- Cost tracking on every submit.

After each, add a scripts/test-<provider>.ts that hits the real staging API and shows me the output.
```

---

## Prompt 10 — Router + circuit breaker + GATE 2

```
Implement items 2.9 (provider router), 2.10 (circuit breaker), 2.11 (cost tracking).

The router must select a provider per shot based on: visualTreatment, plan tier, provider health, budget remaining. It must fall through candidates if the first choice is unhealthy or over budget.

The circuit breaker opens after 5 failures in 60s and stays open for 5 min.

Add a scripts/test-router.ts that:
1. Configures a fake shot with visualTreatment=AI_CLIP, plan=STANDARD
2. Calls the router
3. Confirms Runway is selected
4. Simulates Runway failing 5 times
5. Calls the router again
6. Confirms a fallback (Luma or Fal) is selected

Run it. This closes GATE 2. Update PROGRESS.md.

Then STOP and wait for me to confirm before starting Phase 3.
```

---

## After Prompt 10

You will have:
- A working repo with typecheck, tests, CI
- Full Prisma schema across all 35 tables
- The four `@/lib/*` integration points wired
- Kill switch working
- Provider adapter framework with 4 real providers (Anthropic, Runway, ElevenLabs, Shotstack)
- Provider router with circuit breaker
- Cost tracking on every provider call

This is roughly 3-4 days of Claude Code work at good pace. From here, use CLAUDE.md and BACKLOG.md as the ongoing reference — Claude Code doesn't need prompt scripts anymore, it can work through the backlog with prompts like:

- "Start Phase 3, item 3.1. Show me the plan first."
- "Continue with the next backlog item."
- "GATE 3 review: run the end-to-end test and show me the output."

## When you get stuck

If Claude Code produces something wrong:
- Don't accept the diff. Say "no, this doesn't match spec Section X.Y because [reason]. Try again."
- If it repeats the mistake, cite the exact spec paragraph.
- If it's a genuine ambiguity in the spec, resolve it and add a decision note to `PROGRESS.md`.

If Claude Code seems stuck in a loop or producing low-quality output:
- Start a fresh session (loses context but often unblocks).
- Point it at the specific spec section again.
- Break the task into smaller pieces.

If a provider integration fails against real APIs:
- The spec's API examples may be slightly out of date. Trust the actual provider docs.
- Have Claude Code read the provider's current docs (it can fetch them).
- Never accept "I'll simulate this for now" — real integration or don't ship it.
