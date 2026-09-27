# PROGRESS.md — PostMind Studio Build Log

One line per completed backlog item. Newest at the top.

**Format:** `[YYYY-MM-DD] [phase.item] Short description of what was done.`

---

[2026-09-27] [GATE 8] Passed on automated evidence (autonomous build mode): a styled hook overlay was added to an existing (generated) project, previewed, and the project re-rendered with it and a whole-video watermark; the Shotstack edit carried rich-text overlay clips and their fonts. FFmpeg pre-render verified in CI against real ffmpeg. Live run pending provider keys and hosted fonts.

**Phase 8 status: overlay engine built (backend). The overlay editor UI is Phase 10.**

[2026-09-27] [8.7] POST /overlays/:id/preview: ≤3s, preview-resolution Shotstack render of the overlay's shot with just that overlay (documented output.range + resolution "preview"), copied to storage, 1h signed URL.
[2026-09-27] [8.6] Endpoints (A4.8): GET|POST /overlay-presets (?group, ?businessId), PATCH|DELETE /overlay-presets/:id (org/business presets only), GET|POST /shots/:id/overlays, PATCH|DELETE /overlays/:id, POST /renders/:id/overlays/bulk (whole-video or per listed shot), plus POST /renders/:id/rerender, which A4.8 references ("a subsequent /rerender call"): re-composes with current overlays, no Layer 1–4 spend. Overlays are editable only when the project is reviewable; timing must sit inside the shot/render.
[2026-09-27] [8.5] Auto-suggestion (A4.5): Layer 2 persistence turns each shot's onScreenText into an overlay — first shot Hook (TikTok Native), last shot CTA (Pulse Button), others Subtitle (Box Background) — with brand-kit colour/font substitution. Shots with overlays no longer get the plain html caption.
[2026-09-27] [8.4] overlays/prerender.ts: glitch (RGB-split jitter), karaoke (word-by-word highlight, evenly timed) and counter (count-up via FFmpeg %{eif}) rendered by FFmpeg to ProRes 4444 with alpha (Shotstack composites MOV alpha; WEBM alpha is reported unsupported), cached per content hash, placed as video clips. User text reaches FFmpeg only via textfile (argv, no shell, private temp dir).
[2026-09-27] [8.3] overlays/shotstack.ts: TextOverlay → Shotstack clip using `rich-text` (Shotstack's reference marks the `text` asset A4.6 shows as deprecated): font/weight/italic/colour+alpha, letter spacing, line height, stroke, shadow, box/rounded background, alignment, anchor → offset (y up), rotation, fade/slide transitions with Fast/Slow by duration, scale tweens for scaleIn/popIn, offset tweens for wave, typewriter animation. Overlapping overlays are packed onto separate top tracks; timeline.fonts lists every family used.
[2026-09-27] [8.2] 28 built-in presets across the seven A4.3 groups (hook 5, subtitle 4, CTA 4, quote 4, statistic 4, story 4, brand 3), seeded idempotently by db:seed.
[2026-09-27] [8.1] Models already in the Phase 1 schema; overlays/params.ts is the shared zod schema for the A4.2 parameters (strict, bounded; colours #RRGGBB[AA], font names restricted).

**Phase 8 security review — fixed:** bulk overlays bypassed the 12-per-shot cap (HIGH: unbounded overlays → hours of FFmpeg pre-render per compose); the bulk endpoint now applies the same per-shot cap and at most 6 whole-video overlays per project. Preview renders (MEDIUM: billed, unlimited, callable with read access) now need studio:project:write, a reviewable project, and are capped at 30 composer renders per project per hour. Counter values bounded to ±1e9. Verified not exploitable: FFmpeg filtergraph/argv injection, %{…} expansion from user text, font-path traversal, cross-tenant presets/overlays.

**Phase 8 review list:**
- Fonts: Shotstack has no system fonts, so STUDIO_FONTS_BASE_URL must host each family as <FamilyWithoutSpaces>.ttf; composing a video with overlays fails with a configuration error otherwise. Shotstack's reference and its conventions page disagree on whether font.family is the embedded family name or the file name — verify with the first live render.
- Animation fidelity: blurIn falls back to a fade (no documented blur tween); slide directions follow Shotstack's travel-direction naming (slideInLeft → "slideRight") — confirm visually. Transition speed is Shotstack's fixed normal/Fast/Slow, not the exact animationInMs.
- Karaoke timing is evenly spread across the overlay: word-level voice timing needs a transcription provider (AssemblyAI, not built).
- Slideshow slides use their built-in text rendering; per-slide text overlays need a slide→overlay link that the A7 schema doesn't have (overlays attach to shots or renders). Whole-video overlays work for slideshows.
- Whole-video overlays attach to a render and are carried to later renders of the same platform.
- Template overlayDefaults (Phase 7) name presets by intent; they are not yet applied to slides.

[2026-09-27] [GATE 7] Passed on automated evidence (autonomous build mode): a Listicle 5 slideshow was built from a topic, auto-populated from a real image library (library matches + generated gaps), edited, generated and composed end to end on real Postgres with scripted providers. Live run pending provider keys.

**Phase 7 status: slideshow mode built — templates, slides API, auto-populate, slideshow composition.**

[2026-09-27] [7.7] Slide endpoints (A8.3): GET|POST /projects/:id/slides, PATCH|DELETE /slides/:id, POST /slides/:id/reorder; GET|POST /slideshow-templates (?category; save a slideshow's structure as an organisation template). Slides are editable only in DRAFT / FAILED / REJECTED / QUALITY_FAILED / READY_FOR_REVIEW; every image/video id must belong to the organisation (and business, for library images); each slide reports `problem` when it can't render yet.
[2026-09-27] [7.6] Slideshow composition: plan step for SLIDESHOW skips Layers 1–4 (A5.6), fails fast with per-slide reasons if anything is missing, runs the same pre-generation text-safety gate, then composes. slideshow/edl.ts builds the Shotstack edit per slide type (Ken Burns via documented clip effects; BEFORE_AFTER as before → wipe → after with labels; QUOTE/STATISTIC/PRODUCT text via escaped html assets over the image). No AI video is generated for slideshows.
[2026-09-27] [7.5] POST /projects/:id/auto-populate (A5.5): project → SCANNING, worker writes pending listicle/hook/CTA text from the topic with Claude (never quotes, statistics or prices), matches each image slide to the best unused library image by pgvector similarity (≥ 0.30), generates the rest (max 5 per run), reports Unsplash use to download_location, then returns to the previous state.
[2026-09-27] [7.4] Eight built-in templates (A5.4) as data (slideshow/templates.ts), seeded idempotently by `db:seed` (organisationId = null): Photo dump, Listicle 5, Listicle 10, Before/after, Product showcase, Quote reel, Statistic reel, Team introduction.
[2026-09-27] [7.3] Slide types (A5.3) with their duration ranges (user durations are clamped); per-type content schema (text, number, quote/author, value/label, product name/features/price, before/after image ids).
[2026-09-27] [7.1–7.2] Already in the Phase 1 schema (SLIDESHOW source type, SCANNING state, slideshow_slides, slideshow_templates). POST /projects accepts sourceType SLIDESHOW with `slideshow: { templateId + inputs | slides }` (A8.5); `brief` is required only for other source types.

**Phase 7 security review — fixed:** cross-business video-clip reference (HIGH): VIDEO_CLIP slides accepted any clip in the organisation; clips must now come from a project of the same business, at slide write time and again at composition. Slide ordering race (MEDIUM): add/delete/reorder lock the project row (SELECT … FOR UPDATE) and re-read the slide before shifting sortOrders. Generation cycling (LOW): auto-populate also stops at 100 generated images per organisation per 24h.

**Phase 7 review list:**
- Music (A5.4 musicMood) is stored on templates but not used: there is still no music provider (Phase 3 note). Slideshows render silent unless narration is added later.
- Text on slides uses Shotstack html assets until the overlay engine (Phase 8) replaces them; overlayDefaults on templates name the Phase 8 presets.
- Product showcase from "PostMind content library" (A5.1) needs a Core content API; products are passed in explicitly for now.
- Similarity threshold 0.30 and the 5-generation cap are first guesses; tune with real embeddings.
- VIDEO_CLIP slides take an existing VideoAsset; there is no clip upload endpoint yet.

[2026-09-27] [GATE 6] Passed on automated evidence (autonomous build mode): scan → classify → library → search exercised end to end on real Postgres/pgvector with a fake site and scripted providers. Live run on the operator's own site pending provider keys (Anthropic, OpenAI, Pexels/Storyblocks).

**Phase 6 status: website scan, business profile and image library built; every A6.8 endpoint integration-tested.**

[2026-09-27] [6.7] Semantic search: text-embedding (1536-d) of each image's description (alt text, prompt, tags) stored in image_library.embedding; POST /image-library/search ranks by pgvector cosine distance, scoped by organisation + business.
[2026-09-27] [6.6] Image library endpoints: GET /image-library (businessId, source, tag, cursor), GET|DELETE /image-library/:id (object removed from S3 too), POST /image-library (multipart upload, 15 MB, Content-Length required), POST /image-library/generate (gpt-image via the router as an IMAGE_STILL, kept in the library), POST /image-library/search, POST /image-library/refresh (queued, deduped per minute).
[2026-09-27] [6.5] POST /businesses/:id/scan-website (ownershipConfirmed required and audited; one running scan per business), GET /businesses/:id/scans, GET /scans/:id (pages, images per source, errors), GET|PATCH /businesses/:id/business-profile (user edits set editedByUser; re-scans then keep them).
[2026-09-27] [6.4] Image ingestion: SSRF-guarded download (15 MB cap) → raster check (image-size) → < 500px long edge dropped → sha256 fingerprint → per-business dedup → scraped images matching a stored stock image dropped → S3 under orgs/<org>/businesses/<biz>/images/. Layer 1 scraped (icons, trackers, social buttons, SVGs filtered; max 60), Layer 2 stock: Pexels + Storyblocks primary, Unsplash fallback (hotlink-only, per Unsplash's API terms), Layer 3 on-demand generation.
[2026-09-27] [6.3] classify.ts: Claude (router text_generation) → BusinessProfile JSON (schema-constrained, zod-validated, lists deduped/capped); site text fenced as data.
[2026-09-27] [6.2] extract.ts (cheerio): title, meta description, og:*, twitter:*, h1–h3, body text (main/article first, 5000 chars), images (srcset best candidate, alt, figcaption, declared size), JSON-LD, same-host links, SPA heuristic; sitemap <loc> parsing.
[2026-09-27] [6.1] fetch.ts + safe-fetch.ts: UA "PostMindStudio/1.0 (+https://studio.postmind.ai/bot)", robots.txt per origin (4xx → allow, 5xx/unreachable → disallow; Crawl-delay honoured up to 10s), 1 req/s + 0–1s jitter per host, 30s timeout, 5 MB HTML cap. SSRF guard: http/https on 80/443 only, no userinfo, non-public IPs refused at DNS-lookup time inside the connection (no rebinding window), redirects re-validated per hop. crawl.ts: homepage → sitemap + links (prioritising about/products/shop/services) → up to 20 more pages, early stop when the site vocabulary is stable; Browserless /content fallback for JS-rendered sites when BROWSERLESS_API_KEY is set (Playwright not bundled).

**Phase 6 security review — fixed:** business-id squatting (HIGH): a tenant could claim another tenant's business id first and lock them out, because business_profiles.businessId was globally unique; uniqueness is now (organisationId, businessId) for profiles and (organisationId, businessId, fingerprint) for the image library (migration 20260927010000, DEVIATION from A7.7), so tenants can never collide. Cost/quota abuse (MEDIUM): scans capped at 3 concurrent and 25 per 24h per organisation, stock refreshes at 100 queries/hour per organisation (429 with Retry-After). Still open: stock searches are free APIs outside the pence budget ledger (kill switch still applies at job start); Pexels has no safe-search parameter, so LLM-derived queries from a hostile site could pull unwanted stock images into a library (mitigated only by the user-editable profile — image moderation belongs with Phase 12 hardening); Unsplash use-reporting happens when an image is placed in a slideshow (Phase 7), not at search.

**Phase 6 review list:**
- Fingerprint is sha256 of the bytes, not a perceptual hash: re-encoded or resized copies are not deduplicated, and the stock-photo filter only catches byte-identical copies of stock images Studio itself has downloaded (no external stock-hash database exists in the specs). A dHash would need an image decoder (sharp).
- Unsplash: its API terms forbid storing copies, so Unsplash results are stored as hotlinks (no S3 object) with attribution and the download_location tracking URL in licenseNotes. Reporting use to Unsplash must happen when an image is placed in a video (Phase 7 auto-populate), not at search time.
- Storyblocks download signing uses the download resource path including the item id (docs show only the search example); verify with a live key.
- A6.6 refresh cadence (30-day rescans, weekly stock delta, ETag/Last-Modified skip) needs a scheduler; manual refresh is built, the recurring schedule is not (Phase 11 cron alongside analytics polling). website_scans has no etag column, so the skip-if-unchanged rule would need a migration.
- A6.7 Enterprise DNS-TXT ownership verification and the 24h purge on disputed ownership are not built.
- Search embeds image descriptions, not pixels: images with no alt text/tags are embedded from their tags only (scraped images get the business's themes).
- Image generation is synchronous in the request (maxDuration 120s).
- businessId remains unverifiable against Core; all Feature D data is keyed per organisation, so an unverified id can only affect the caller's own data.

[2026-09-27] [GATE 5] Passed on automated evidence (autonomous build mode): publishers unit-tested against recorded request shapes; publish/schedule/cancel/retry/takedown and OAuth connect/disconnect integration-tested on real Postgres. Live posting to each platform pending operator credentials and a test account per platform.

**Phase 5 status: publishing built for TikTok, YouTube (Shorts + long-form), X and LinkedIn; Instagram/Facebook publishers built but blocked on an Engagement token endpoint.**

[2026-09-27] [5.11] Scheduled publishing: ScheduledPublication row + BullMQ delayed `fire-scheduled-publication` job (jobId stored); PENDING→FIRED CAS makes the fire idempotent; cancel flips PENDING→CANCELLED so a fired job is a no-op. Schedule window 1 min–180 days.
[2026-09-27] [5.10] POST /publications (202; validates project approved, render QC PASSED/FORCE_APPROVED, platform aspect/duration/size, caption and hashtag limits, connection active, no duplicate to the same account), GET /publications/:id, POST /publications/:id/{cancel,retry,takedown}. New capability `studio:publication:write`.
[2026-09-27] [5.9] publish-video worker: SCHEDULED→PUBLISHING CAS, credentials (Studio connection or Engagement/Meta), 24h signed source URL + ranged reads for chunked uploads, PUBLISHED + audit + Engagement attribution (best effort, POST /api/engagement/internal/publications/attribute), project roll-up to PUBLISHED / PARTIALLY_PUBLISHED; failures record errorCode (PlatformError class) and retryCount.
[2026-09-27] [5.8] OAuth: POST /platform-connections/oauth-init (server-side single-use state, 10 min TTL, PKCE S256 for X, same-origin returnTo), GET /oauth-callback (state-authenticated, no JWT), GET /platform-connections (no token fields), DELETE /platform-connections/:id (tokens wiped). Tokens stored AES-256-GCM envelope-encrypted (KMS data key; local master key outside production) with org/platform/kind AAD; refresh 5 min before expiry with a CAS write; refused refresh → needs_reconnect. New capability `studio:connections:manage`.
[2026-09-27] [5.7] FacebookReelPublisher: /video_reels start → rupload (file_url) → finish(PUBLISHED) → status poll; takedown via DELETE.
[2026-09-27] [5.6] LinkedIn: Linkedin-Version 202609; /rest/videos initializeUpload → part PUTs (ETags) → finalizeUpload → status poll → /rest/posts; little-text escaping; hashtags via the hashtag template; takedown via DELETE.
[2026-09-27] [5.5] X: v2 media upload initialize/append (5 MB chunks)/finalize/status → POST /2/tweets; takedown DELETE /2/tweets/:id.
[2026-09-27] [5.4] YouTube: resumable upload (8 MiB chunks, 308 handling), containsSyntheticMedia=true, videos.list processing poll; Shorts get #Shorts; takedown DELETE videos.
[2026-09-27] [5.3] InstagramReelPublisher: REELS container (video_url) → status_code poll every 60s → media_publish → permalink; takedown DELETE. Credentials: MetaCredentialSource, currently NotImplemented (see review list).
[2026-09-27] [5.2] TikTok Content Posting API: creator_info → video/init FILE_UPLOAD (is_aigc=true, privacy from creator_info options) → chunked PUT → status fetch poll; fail_reason classification. No takedown (no documented delete API).
[2026-09-27] [5.1] platforms/interface.ts: PlatformPublisher {publish, takedown?} over a VideoSource (size, signed URL, ranged reader); per-platform rules (aspect ratios, durations, size, caption/hashtag/title limits) and caption composition (spec 9.8).

**Phase 5 security review — fixed:** duplicate-publish race (two concurrent POSTs could both pass the duplicate check and post twice) closed with a transaction-scoped advisory lock on (render, platform, account) around check + insert; takedown errors no longer relay the platform's raw error text (curated message per error class, raw text logged server-side); pull-upload signed URL lifetime cut from 24h to 1h. Not changed: businessId on OAuth init is unverified free text (same Core-contract gap as Phase 4).

**Phase 5 review list:**
- BLOCKER (Instagram/Facebook): CLAUDE.md says reuse Engagement's Meta tokens, but the Engagement handover documents no internal endpoint that returns a channel token. `unavailableMetaCredentials` throws NotImplementedError, so these publications FAIL with a clear reason instead of pretending. Needs an Engagement endpoint (e.g. GET /api/engagement/internal/channels/:id/token) agreed with that team.
- Engagement attribution endpoint path `/api/engagement/internal/publications/attribute` is ASSUMED (backlog names `/internal/publications/attribute-conversation`); confirm with the Engagement team.
- platformUrl is null for TikTok, YouTube and X unless the API returns a URL: public URL formats are not in the API docs, so none are constructed.
- TikTok has no delete API: takedown returns 409 with a clear message.
- API versions pinned from current docs: Graph v26.0, Linkedin-Version 202609. Both deprecate on a schedule; bump via env/constant.
- No per-platform analytics polling yet (Phase 11).

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
