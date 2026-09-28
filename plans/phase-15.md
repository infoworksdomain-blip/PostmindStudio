# Phase 15 — spec coverage gaps

**Source.** A section-by-section audit of the v1.0 spec (§1–§21) and Addendum v1.1 (A1–A14), with
the Planning Playbook used for open decisions, against the code on branch `phase-14`:
`src/app/api/studio/**` (109 route files), `src/lib/studio/**`, `src/components/studio/**`,
`prisma/schema.prisma`, BACKLOG.md, PROGRESS.md (including every phase review list and the
Operator decisions), `plans/phase-13.md`, `plans/phase-14.md` and the "Not built yet" register
(`demo/tour/not-built-data*.ts`). Each claim was checked with a grep, not assumed.

**Rule for inclusion.** An item is listed only when it is **not implemented** and **not already
covered** by a Phase 13/14 item or a register item. Things already queued (email delivery,
business list, Meta reconciliation, BPM/CLIP/CLAP, style-memory router adjustment and sentiment,
LinkedIn/TikTok/Meta analytics depth, the 13.38 fallback adapters, org hard purge, S3 lifecycle,
alerting, rehearsals, k6, PITR, live runs, corpus runs, Core Meta wiring, beta/T&S/on-call) are
**not** repeated. Items that PROGRESS records as "NOT BUILT" but that no phase or register item
plans are included, with the PROGRESS reference.

**Conventions** are the same as Phase 13: every endpoint is a real route (zod, `withStudioRoute`
or `withInternalRoute`, tenant-scoped, audited on mutations, unit + API tests). Blocked items ship
their final contract and answer `501 { ok: false, error: "not_implemented", message }` until the
dependency lands. Envelopes: `{ ok: true, ... }` / `{ ok: false, error, message, details? }`.

---

## What the audit found already covered

So the gaps below are read in proportion:

- **§8 API reference:** every endpoint in §8.2–§8.7 exists, and §8.8 purge exists. Two §8.8
  internal endpoints are missing (15.E3, 15.W1).
- **A8 API additions:** all 39 A8.1–A8.4 endpoints exist.
- **§7 / A7 schema:** all 28 spec models exist with every spec field. The extra columns are
  documented DERIVED columns.
- **Pipeline:**
  - Layers 1–9 run end to end.
  - The restricted-topic confirmation (§13.3) and the vague-brief "three directions" (§5.2) are built.
  - The §15.2 polling cadence and the §15.3 90-day decay window are built.
  - Analytics roll-up and retention (§7.15, video_analytics only) are built.
- **Deliberate drifts already in PROGRESS** (not repeated here):
  - Suno replaced by ElevenLabs Music
  - DALL-E 3 replaced by gpt-image-2
  - Runway model names
  - Luma Agents API
  - HeyGen v3
  - Claude OCR per keyframe
  - single library category
  - nullable embedding
  - image-library uniqueness
  - H.264 Baseline
  - voice inside the asset job
  - Engagement attribution path

---

## Summary

| Classification | Items | Est. days |
| --- | --- | --- |
| Buildable now (Tracks A–E) | 46 | ≈ 84 |
| Blocked on a dependency (Wave B-style contracts) | 6 | ≈ 9 (contract + finish) |
| Needs a product decision | 9 | — (0.5–3 d each once decided) |
| Out of scope per CLAUDE.md "What not to build" (Appendix A) | 4 | — |
| Deferred by the spec itself to v1.1+/v1.2 (Appendix B, not gaps) | 13 | — |
| Unrecorded spec drift (Section 4) | 17 | fixes folded into the items above |

Five parallel tracks with disjoint file ownership (Section 5). The longest is about 20 days.

---

## 1. Buildable now

### Track A — Publishing and distribution (≈ 17.5 days)

**15.A1 Instagram feed and Facebook feed video** — 3 d

- **Spec:** §9.1 lists "Instagram feed … 1:1 or 4:5 MP4". §9.7 says "For Facebook feed video:
  resumable upload flow (different from Reels)".
- **Missing:**
  - `PLATFORMS` has `instagram_reel` and `facebook` (Reels only). `platforms/rules.ts` says
    "Feed-video upload is not built".
  - So there are 7 destinations, and §3.1 says 8.
- **Build:**
  - `instagram_feed` (media_type VIDEO container, 1:1/4:5) and `facebook_feed`
    (`/{page-id}/videos` upload_phase start/transfer/finish) publishers and rules. Read the
    current Graph docs first.
  - Create-screen formats and connection mapping.
- **Example:**

```http
POST /api/studio/publications
{ "renderId": "rnd_4", "platform": "facebook_feed", "connectionId": "pc_fb1", "caption": "…", "hashtags": [] }
→ 202 { "publication": { "id": "pub_9", "platform": "facebook_feed", "state": "PUBLISHING" } }
```

- **Screens:** create platform checkboxes, the publish panel and connections labels.
- **Tests:**
  - publisher unit tests against doc-shaped fakes
  - a rules test for 1:1/4:5
  - `test/api/publications.test.ts` cases
  - a golden META-03

**15.A2 TikTok upload-to-inbox mode (UPLOAD fallback)** — 1.5 d

- **Spec:** §18.1 says "Studio submits for DIRECT_POST during App Review; UPLOAD-only fallback
  is supported." §9.2 names `/v2/post/publish/inbox/video/init/`.
- **Missing:** only Direct Post is built.
- **Build:**
  - Fall back to inbox upload when the connection lacks `video.publish` or the creator's privacy
    options forbid posting.
  - The publication ends in a new terminal `metadata.tiktokMode: "inbox"` with the user told to
    finish in the TikTok app.
- **Example:**

```http
GET /api/studio/publications/pub_3 → 200 { "publication": { "state": "PUBLISHED", "metadata": { "tiktokMode": "inbox", "note": "Finish posting in the TikTok app" } } }
```

- **Tests:** tiktok.test.ts (scope missing → inbox; status SEND_TO_USER_INBOX), plus the UI note.

**15.A3 Render thumbnails, custom YouTube thumbnail and inline edit** — 3 d

- **Spec:**
  - §14.2: "Each variant has its own caption, hashtags, thumbnail — all editable inline."
  - A6.5: "generates a thumbnail candidate from a keyframe + text overlay".
  - §9.4 step 5 calls `thumbnails.set`.
- **Missing:**
  - `video_renders.thumbnailS3Key` is never written.
  - The `studio-thumbnails` bucket is unused.
  - There is no `thumbnails.set` call.
- **Build:**
  - A new worker `generate-thumbnail.ts`: a keyframe, the hook text overlay and a library image
    background weighted by past engagement (A6.5). It writes to `S3_BUCKET_THUMBNAILS`.
  - An upload or replace endpoint.
  - The YouTube publisher sets the thumbnail after upload (50 quota units).
- **Example:**

```http
GET  /api/studio/renders/:id → (existing) + { "thumbnailUrl": "https://…signed" }
POST /api/studio/renders/:id/thumbnail  { "source": "keyframe", "atSec": 1.2, "overlayText": "3 tips" } | multipart file
→ 200 { "render": { "id": "rnd_1", "thumbnailUrl": "…" } }
```

- **Screens:** variant card thumbnail with Change (pick a frame, upload or regenerate).
- **Tests:** worker unit test, the API (auth/validation/tenant/audit), youtube.test.ts
  thumbnails.set and the variant-card component.

**15.A4 Voiceover captions per format (SRT, YouTube captions, burned-in for Reels)** — 3 d

- **Spec:**
  - §3.1 says captions are "Auto-generated in any supported voice language; user-editable".
  - §5.8 says "YouTube gets uploaded as SRT alongside the video."
- **Missing:**
  - Generated videos get only `onScreenText` overlays.
  - Narration is never captioned (only UPLOAD projects are, 13.5).
  - `captionsSrtS3Key` is never written, and there is no `captions.insert`.
- **Build:**
  - Caption lines from the 13.6 word timings go into a new `overlays/voice-captions.ts`.
  - Reels, Shorts and Facebook get subtitle overlays burned in by default (editable like any
    overlay).
  - YouTube gets an SRT file written at compose and uploaded with `captions.insert` (400 units).
  - TikTok gets burned-in "native-style" preset.
- **Example:**

```http
GET /api/studio/renders/:id/captions → 200 { "srtUrl": "…", "lines": [{ "startAtSec": 0.4, "endAtSec": 2.1, "text": "Friday means sourdough" }] }
```

- **Tests:** caption grouping unit tests, SRT formatter, youtube captions.insert fake and a golden
  CR-04.

**15.A5 Project-level scheduling, drip queue and cross-platform stagger** — 2.5 d

- **Spec:**
  - §3.1 lists "Publish now, schedule to time, drip queue, auto-publish".
  - The §8.2 sample body uses `publishPolicy: "SCHEDULED"` with `scheduledStartAt`.
  - §9.9: "stagger by 15-60 minutes across platforms by default".
- **Missing:**
  - `publishPolicy SCHEDULED` and `scheduledStartAt` are validated and stored, but nothing acts
    on them. This is **unrecorded drift**.
  - There is no drip queue and no default stagger.
- **Build:**
  - On approval, a SCHEDULED project creates publications for its targets at `scheduledStartAt`,
    staggered by `STUDIO_DEFAULT_STAGGER_MINUTES` (default 30, range 15–60), through the outbox
    (13.21).
  - A per-business drip queue places approved videos into the next free slot.
- **Example:**

```http
PUT /api/studio/businesses/:id/drip-queue { "slots": [{ "weekday": 1, "time": "08:30", "timezone": "Europe/London" }], "platforms": ["tiktok","instagram_reel"] }
→ 200 { "dripQueue": { "slots": [ … ], "nextSlotAt": "2026-10-05T07:30:00Z", "queued": 2 } }
POST /api/studio/projects/:id/approve → 200 { …, "scheduled": [{ "platform": "tiktok", "scheduledFor": "2026-10-01T09:00:00Z" }, { "platform": "instagram_reel", "scheduledFor": "2026-10-01T09:30:00Z" }] }
```

- **Screens:** Create "Schedule" option; calendar shows drip slots.
- **Tests:** approval → scheduled rows, stagger bounds, drip slot allocation (DST), and a golden
  GP-16.

**15.A6 Best-time suggestions (advisory)** — 1.5 d

- **Spec:** §9.9 asks for "per-platform per-day best-hour recommendations. Not enforced — advisory
  only."
- **Build:** aggregate the org's `video_analytics` by platform, weekday and hour. Merge in
  style-memory `posting_time`.

```http
GET /api/studio/analytics/best-times?businessId=biz_1&platform=tiktok
→ 200 { "data": [{ "weekday": 2, "hour": 8, "score": 0.81, "basis": "14 videos" }], "sufficientData": true }
```

- **Screens:** the schedule picker shows "Suggested: Tue 08:00".
- **Tests:** the aggregation unit test (sparse data → `sufficientData: false`) and the API.

**15.A7 Per-platform caption and hashtag suggestions** — 1.5 d

- **Spec:** §9.8 says "the UI shows all captions side by side with a suggested-per-platform
  default".
- **Missing:** the publish panel defaults every platform to `brief.hook` with no hashtags.
- **Build:** one Claude call per project that follows the §9.8 conventions per platform
  (hashtag counts, #Shorts, the first-line hook). It is cached on `project.metadata`.

```http
POST /api/studio/projects/:id/caption-suggestions → 200 { "suggestions": { "tiktok": { "caption": "…", "hashtags": ["bakery","sourdough","leeds"] }, "linkedin_video": { … } } }
```

- **Tests:** validation against `PLATFORM_RULES` limits and publish-panel defaults.

**15.A8 Publications list with live view counts** — 0.5 d

- **Spec:** §14.3 asks for "every published variant across all platforms with live view counts".
- **Build:** `GET /publications` rows gain `latestMetrics: { views, likes, comments, at } | null`
  from the latest bucket. Add a Views column.
- **Tests:** the API and the list component.

**15.A9 Publish-error handling fixes (drift)** — 1 d

- **Spec:**
  - §9.4 says "quotaExceeded → back off to next quota window".
  - §9.3 says "CAPTION_TOO_LONG → truncate at 2200 chars, warn user".
- **Build:**
  - YouTube `quota_exceeded` requeues the publication delayed to the next Pacific-midnight quota
    reset instead of failing.
  - Caption over-limit: keep the 400 on explicit user input (safer), but auto-publish targets
    truncate at a word boundary and record `metadata.captionTruncated`. Record the decision in
    PROGRESS.
- **Tests:** publish-video retry path and caption module.

### Track B — Composition and media quality (≈ 17.5 days)

**15.B1 Brand-kit media: logo, watermark, intro/outro cards, uploaded fonts, soft delete** — 3.5 d

- **Spec:**
  - §10.1: "Logo asset (uploaded PNG with transparency)", "Intro card and outro card", and
    "Google Fonts or uploaded TTF".
  - A11.5: "Uploaded fonts require the user to confirm licence for commercial embedding."
  - §8.5 says DELETE is a "Soft-delete".
- **Missing:**
  - The brand-kit API accepts none of `logoAssetId`, `watermarkAssetId`, `introCardAssetId` or
    `outroCardAssetId`, and the composer never renders them.
  - There is no font upload.
  - DELETE hard-deletes. This is **unrecorded drift**; brand_kits has no `deletedAt`.
- **Build:**
  - Upload kinds `brand_logo`, `brand_watermark`, `brand_card` and `brand_font` (TTF/OTF →
    WOFF2 for the editor, TTF for Shotstack under `STUDIO_FONTS_BASE_URL`), with licence
    confirmation stored.
  - The EDL adds the logo bug, watermark track, and intro and outro clips.
  - Migration adds `brand_kits.deletedAt`.

```http
POST  /api/studio/uploads { "kind": "brand_font", "contentType": "font/ttf", "fileName": "Brandon.ttf", "licenceConfirmed": true } → 201 { "upload": { … } }
PATCH /api/studio/brand-kits/:id { "logoAssetId": "ast_logo", "introCardAssetId": "ast_intro", "fontPrimary": "upload:fnt_1" } → 200 { "brandKit": { … } }
```

- **Screens:** brand-kit form media pickers.
- **Tests:** EDL unit tests (logo/intro/outro placement), uploads API and soft-delete API.

**15.B2 Remaining §13.1 quality checks** — 3 d

- **Spec:** §13.1 requires:
  - "Voiceover peaks align to shot boundaries"
  - "Captions align to voiceover ±200ms"
  - "Watermark visible in required frames"
  - "Colours, fonts, logo present"
- **Missing:** `quality-checks.ts` records `audio_sync`, `caption_sync`, `watermark` and
  `brand_kit` as `not_run`.
- **Build:**
  - `caption_sync`: 13.6 word timings compared with caption overlay times.
  - `audio_sync`: voice-asset boundaries compared with shot boundaries from the EDL.
  - `watermark` and `brand_kit`: an EDL-level assertion that the kit's watermark, logo and fonts
    are on the timeline, plus an ffmpeg frame sample at the watermark rect.
  - Failure actions follow the §13.1 table (brand_kit = user review, not a hard fail).
- **Tests:** a unit test per check (pass/fail fixtures) and a golden QF-02.

**15.B3 Voice fitted to the shot, and tone-matched stock voices** — 2 d

- **Spec:** §5.5 says:
  - "either the shot is extended or the voiceover is trimmed automatically"
  - "one of five pre-selected ElevenLabs voices matched to the brand's declared tone"
- **Missing:**
  - Narration is cut at the shot length (`edl.ts`).
  - There is one `ELEVENLABS_DEFAULT_VOICE_ID`.
- **Build:**
  - After TTS, probe the duration. If it runs more than 5% over, extend the shot when its
    treatment allows (stills, text cards). Otherwise regenerate at a faster speed setting, if
    ElevenLabs documents one (verify first), or trim at a word boundary using 13.6 timings.
  - `STUDIO_STOCK_VOICES` maps five tone keywords to voice ids, chosen from `brand_kits.toneKeywords`.
  - This reads `video_scripts.language` from 15.C5.
- **Tests:** fit decision unit tests and voice selection tests.

**15.B4 Per-shot music ducking** — 1 d

- **Spec:** §5.7 lists "music duck automation". PROGRESS [OPS-music] says NOT BUILT ("a constant
  bed level is used").
- **Build:** split the music track into clips with volume keyed to shots with and without
  narration (documented Shotstack volume, no invented keyframes).
- **Tests:** EDL unit test.

**15.B5 IMAGE_STILL shots use the business image library first** — 1.5 d

- **Spec:** A6.5 says "the router queries the image library before falling to DALL-E 3". A6.3
  says "Every generated image is stored in the library so it can be reused."
- **Missing:**
  - `generate-asset.ts` IMAGE_STILL always generates.
  - Generated shot images are not added to `image_library`. This is **unrecorded drift**.
- **Build:**
  - A semantic search (existing `image-library/search` service) over the shot's scene
    description, using the populate.ts 0.30 threshold. Only on a miss, generate and ingest with
    `source: GENERATED`.
- **Tests:** a generate-asset unit test (hit → no provider call) and the DB test.

**15.B6 Asset fingerprint reuse and composition cache** — 2 d

- **Spec:**
  - §5.4 says "we reuse rather than regenerate — direct cost saving".
  - §5.7 says "This enables caching and cost saving on trivial re-renders."
- **Build:**
  - `video_assets.fingerprint` = hash(provider, capability, normalised prompt, duration, aspect,
    seed image). A match in the org is reused with a zero-cost ProviderJob marked `reused`.
  - Compose hashes the EDL; an identical EDL for the same project and platform re-points to the
    existing render.
- **Tests:** reuse unit and DB tests, and a cost-regression journey showing the saving.

**15.B7 Per-format render presets (fps, bitrate, 720p drafts, 4K)** — 2 d

- **Spec:**
  - §5.8: "Each target format has its own render preset: aspect ratio, resolution, bitrate, frame
    rate".
  - §3.1: "720p for draft previews; 4K for YouTube long-form (Plus tier+)".
- **Missing:** `OUTPUT_RESOLUTION = '1080'` and one fps for every output. This is **unrecorded
  drift**.
- **Build:**
  - A preset table per platform.
  - Project `fps` 24/30/60.
  - 4K only for `youtube` at PLUS/ENTERPRISE.
  - Overlay previews stay at `preview`.

```http
PATCH /api/studio/projects/:id { "renderOptions": { "fps": 60, "youtubeResolution": "4k" } } → 200 · 422 { "error": "plan_tier", "message": "4K needs Plus" }
```

- **Tests:** EDL preset tests and the tier check.

**15.B8 MOTION_GRAPHICS shots** — 2 d

- **Spec:** §4.5 maps "MOTION_GFX → Shotstack template". §5.3 has the enum value.
- **Missing:** the treatment is never offered to Layer 2, and generate-asset throws for it.
- **Build:**
  - Composer-rendered motion cards (brand palette + text + documented Shotstack
    shape/transition/effect assets). Read Shotstack's docs before choosing assets; no invented
    fields.
  - No provider call; offered in `availableTreatments` when Shotstack is registered.
- **Tests:** EDL test and a scripting treatment list test.

**15.B9 "We used a fallback provider" notice** — 0.5 d

- **Spec:** §20 says "user notified of quality tier drop if fallback used".
- **Build:** when `providerRouting` shows a later candidate than the first eligible one for the
  tier, set `metadata.fallbacks[]` and show a review-screen note.
- **Tests:** unit and component tests.

### Track C — Planning, providers and create inputs (≈ 13 days)

**15.C1 OpenAI text-generation and transcription fallbacks** — 2 d

- **Spec:**
  - §5.2: "Claude Sonnet by default …; GPT-4o as fallback."
  - §6.5 names Whisper as the captions fallback.
- **Missing:** the router lists `openai` for `text_generation`, but `OpenAIAdapter.capabilities`
  is `['text_to_image','embedding']`. The fallback is therefore silently absent. This is
  **unrecorded drift**.
- **Build:**
  - Add `text_generation` (structured JSON output) and `transcription` (hosted speech-to-text
    with word timestamps). Check the OpenAI docs for the current model names.
  - Register transcription second after AssemblyAI.
- **Tests:** adapter unit tests with recorded fixtures, and a router fallback test (anthropic
  breaker open → openai).

**15.C2 Storyblocks music library pick** — 1 d

- **Spec:** §5.6: "Music fallback: … or a Storyblocks library selection."
- **Build:**
  - `storyblocks-music` adapter (content_type=music), reusing the configured `STORYBLOCKS_API_*`
    keys that 13.27 already uses.
  - Router music list: `elevenlabs-music, storyblocks-music, replicate`.
- **Tests:** adapter and music fallback tests.
- **Note:** the same keys also unblock register item 13.38's **Storyblocks footage**, and
  `PEXELS_API_KEY` (used for images) unblocks **Pexels video**. Move those two out of
  "blocked on accounts".

**15.C3 Per-org, per-provider rate-limit coordination** — 2 d

- **Spec:** §11.4: "If the counter is at capacity, jobs delay via BullMQ's delay() rather than
  fail."
- **Build:**
  - Redis sliding-window counters per (org, provider) and per provider, with limits from
    `STUDIO_PROVIDER_RATE_<ID>`.
  - `runProvider` throws a `RateDeferredError`. The worker runtime `moveToDelayed`s the job
    without counting an attempt.
- **Tests:** a Lua window unit test and a runtime test (deferred, not failed).

**15.C4 Generate overrides and create "Advanced" options** — 2 d

- **Spec:**
  - §8.2: "Body may override brief, tier, providers."
  - §14.1: "Advanced options collapsed — script mode, provider tier override, budget cap,
    schedule, approval workflow."
- **Missing:** `generateInput` has only `rawInput` and `confirmRestrictedTopics`. Create has no
  tier, schedule or workflow controls.
- **Build:**
  - `qualityTier` may only go **down** from the org's plan (never above it).
  - `preferredProviders` per treatment goes through the existing router checks.
  - Create UI: schedule (uses 15.A5), tier, and an approval workflow picker (uses 15.D3).

```http
POST /api/studio/projects/:id/generate { "qualityTier": "STANDARD", "preferredProviders": { "AI_CLIP": ["luma"] } }
→ 202 { "projectId": "prj_1", "state": "QUEUED", "runId": "run_3", "planTier": "STANDARD" }   // 422 when above the plan
```

- **Tests:** API (tier ceiling, unknown provider 400) and create component tests.

**15.C5 Languages (project, script, voice and captions)** — 2 d

- **Spec:** §3.1: "English (UK, US), Nigerian Pidgin (via ElevenLabs custom), plus 20 additional
  languages".
- **Missing:** `video_scripts.language` is always `en-GB`, and nothing lets a user choose.
- **Build:**
  - `language` (BCP 47) on POST/PATCH `/projects`, passed to Layers 1–2 and stored on scripts.
  - Track B consumes it for the voice model and the caption language.
  - The language list comes from ElevenLabs' documented supported languages. Pidgin waits on
    decision P9.
- **Tests:** validation and the prompt contains the language.

**15.C6 Public-figure review flag** — 1 d

- **Spec:** §18.3: "includes a real named individual (public figure) triggers a review-required
  flag automatically".
- **Build:** add `public_figure` to `SAFETY_CATEGORIES`. The verdict is at least REVIEW, which
  goes to the 13.17 queue.
- **Tests:** script-safety unit test and a safety-review golden.

**15.C7 Automatic consent-phrase check on voice clones** — 1 d

- **Spec:** §10.2: "the speaker must record a specific consent phrase before the voice is
  usable."
- **Missing:** PROGRESS [13.13] says NOT BUILT ("kept for review").
- **Build:**
  - Transcribe the consent recording (AssemblyAI).
  - Fuzzy-match against the stored statement: `consentCheck: passed | mismatch | unavailable`.
  - A mismatch keeps the profile `PENDING_REVIEW`.
- **Tests:** matcher unit test and the voice-profiles API.

**15.C8 Platform-native Layer 2 guidance** — 1 d

- **Spec:**
  - §5.3: "21-34s for TikTok / Reels engagement peak, 45-60s for YouTube Shorts".
  - §5.8: the first 1.5 s is framed per platform.
- **Build:** a per-platform guidance block in `buildScriptPrompt` (hook framing, pacing, caption
  style). The Create defaults for Shorts move to 45 s.
- **Tests:** prompt unit test.

**15.C9 Pin shots when regenerating a script** — 1 d

- **Spec:** §8.3: "Regenerate whole script; user may pin certain shots to keep."
- **Build:** `POST /scripts/:id/regenerate { instruction?, pinnedShotIds? }`. Pinned shots keep
  their assets and position. Layer 2 is told to write around them.
- **Tests:** a regenerate-script worker test and the API.

### Track D — Governance, admin and cost controls (≈ 20.5 days)

**15.D1 Feature flags `studio.features.*`** — 2 d

- **Spec:** A12.4: "Any feature can be disabled per-org or globally within 60 seconds via
  SystemFlag toggle."
- **Missing:** `.env.example` documents `FEATURE_*_ENABLED`, but no code reads them. This is
  **unrecorded drift**.
- **Build:** system_flags keys `studio.features.<library|overlays|slideshow|image-library>` plus a
  per-org override, the same 30 s cache as the kill switch, enforced in the route wrapper and the
  workers (403 `feature_disabled`).

```http
PUT /api/studio/admin/features { "feature": "slideshow", "scope": "organisation", "organisationId": "org_1", "enabled": false, "reason": "…" }
→ 200 { "features": { "slideshow": { "global": true, "disabledFor": ["org_1"] } } }
```

- **Screens:** an Admin "Features" tab.
- **Tests:** a flag unit test, per-feature API 403, and "disabling one doesn't break others"
  (A14.2).

**15.D2 A10.3 tier gating and A10.4 caps** — 3 d

- **Spec:**
  - The A10.3 table: INSPIRE Standard+, TEMPLATE Plus+, custom presets and templates Standard+,
    scans 1/3/10/∞ businesses.
  - A10.4: "single scan hard-capped at £0.50", DALL-E "Basic 20, Standard 50, Plus 200,
    Enterprise 1000", slideshow default £1.50.
- **Missing:**
  - Only music, SFX and voice cloning are tier-gated.
  - Slideshows get the £3.50 short-form default. This is **unrecorded drift**.
- **Build:** a `tier-gates.ts` table enforced in the reference/library, preset, template, scan
  and image-generate services (403 `plan_tier` with `requiredTier`). Add a per-scan budget and a
  per-business monthly generation counter.
- **Tests:** a table-driven unit test and one API case per gate.

**15.D3 Multi-step approval workflows** — 3 d

- **Spec:**
  - §7.13: `steps // ordered [{ role, minApprovers }]`.
  - §3.3 agency: "Client-scoped brand kits, approval workflows".
- **Missing:** the `approval_workflows` table is unused. PROGRESS Phase 4 review list says "not
  enforced yet".
- **Build:**
  - CRUD.
  - `appliesTo` matching.
  - Approve advances `stepIndex`. The project stays READY_FOR_REVIEW until the last step.
  - 12-month task retention (15.E8).

```http
POST /api/studio/approval-workflows { "name": "Client sign-off", "steps": [{ "role": "admin", "minApprovers": 1 }, { "role": "client_reviewer", "minApprovers": 1 }], "appliesTo": { "businessIds": ["biz_1"] } }
→ 201 { "workflow": { "id": "wf_1", … } }
POST /api/studio/projects/:id/approve → 200 { "approval": { "stepIndex": 0, "remainingSteps": 1 }, "project": { "state": "READY_FOR_REVIEW" } }
```

- **Screens:** a workflow editor and a review-screen step indicator.
- **Tests:** a step machine unit test and API tests (role, minApprovers, reject at any step).

**15.D4 Dead-letter admin view** — 2 d

- **Spec:** §11.5: "An Admin Centre view lists failed jobs with retry / inspect / drain /
  requeue-with-different-provider actions."
- **Missing:** only counts (13.16) and scope-based re-drive exist.
- **Build:** `GET /admin/queues/:name/failed` (cursor, job data with secrets redacted, failed
  reason). `POST …/failed/:jobId/{retry|requeue}` with an optional `providerId` override.
  `POST …/failed/drain` needs a typed confirmation (never automatic).
- **Tests:** API with an inline queue and audit.

**15.D5 Force-approve review in the Admin Centre** — 0.5 d

- **Spec:** §13.5: "Every force-approve is audited and reviewable in the Admin Centre."
- **Build:** `GET /admin/force-approvals?days=30` (renders with `FORCE_APPROVED`, note, user, failed
  checks). An Admin tab.
- **Tests:** the API.

**15.D6 Two-person approval for the global kill** — 1.5 d

- **Spec:** §19.2: "trigger global generation kill with two-person approval".
- **Build:** `PUT /admin/kill-switch {level:"global"}` creates a pending request. A different
  staff user confirms within 10 minutes. The workspace, project, provider and platform levels are
  unchanged. Break-glass `STUDIO_KILL_SWITCH_SINGLE_APPROVER=true` is audited.
- **Tests:** API (same user refused, expiry) and a rehearsal script update.

**15.D7 Library admin completion and licence filter fix** — 3 d

- **Spec:**
  - A3.8: "Re-run ingestion on selected items", bulk-edit categorisation, licence-status audit.
  - A11.1: "Rows without a licence status are unusable — the API rejects them from search
    results."
- **Missing:**
  - The admin panel says "no staff list endpoint exists yet".
  - `GET /library/videos`, `/similar` and `/recommended` do **not** exclude licence-less rows;
    only `/library/search` does. This is **unrecorded drift**.
- **Build:**
  - `GET /admin/library/videos?licence=missing|SCRAPED|…&retired=true`.
  - `POST /admin/library/videos/bulk { ids, categoryId?, action: accept|override|reject }`.
  - `POST /admin/library/reanalyse { ids }` re-runs analysis and embedding on stored sources.
  - `GET /admin/library/licence-audit`.
  - Add the licence join to the three user list queries.
- **Tests:** API tests, including a CI integration test that unlicensed rows never list (A11.1).

**15.D8 Scan ownership statement and low-confidence classification** — 1 d

- **Spec:**
  - A11.2: "The checkbox text is preserved with the scan record for audit."
  - A13: "low-confidence classifications flagged for user review before use".
- **Build:**
  - Migration: `website_scans.ownershipStatement` (the text shown).
  - The classifier returns `confidence`. Below 0.7, `business_profiles` gains
    `needsReview: true` and the Business screen asks for confirmation.
- **Tests:** scan API and classify unit tests.

**15.D9 SLO and acceptance metrics** — 1.5 d

- **Spec:**
  - §17.1 SLOs (generation p50/p95, "p95 < 3 min from approve to platform live", analytics
    freshness).
  - §3.5 "passes basic quality auto-checks 92%+".
- **Build:** histograms `studio_generation_seconds{kind}`, `studio_publish_latency_seconds`,
  `studio_analytics_first_metric_seconds`; counters for first-attempt publish success and
  quality-gate pass; recording rules and alerts in `ops/prometheus`.
- **Tests:** metrics unit test and promtool tests.

**15.D10 Launch-readiness harnesses (A14.2) and adapter canary (§20)** — 3 d

- **Spec:**
  - A14.2: "Overlay editor pixel-diff CI passes against reference renders for all 25 built-in
    presets" and "Business classifier accuracy >85% on the 50-site labelled test set".
  - §20: "Every adapter has integration tests run daily".
- **Build:**
  - `test/visual/`: an FFmpeg-prerender and HTML-preview pixel diff per preset. Shotstack
    reference renders are captured by the operator on the first live run.
  - `test/eval/classifier.eval.ts` over a fixture manifest; the labelled 50 sites are Playbook
    H-03 people work.
  - Scan timing over the 20-site fixture.
  - Cost-regression journeys for INSPIRE/TEMPLATE with the ±15% check against A10.
  - A daily provider canary workflow (health checks and `Sunset`/`Deprecation` header logging).
- **Last step:** **Operator run** with staging keys.

### Track E — Data rights, integrations and sharing (≈ 15.5 days)

**15.E1 Data export (right of access)** — 3 d

- **Spec:**
  - §18.4: "user can export all their Studio data at studio.postmind.ai/account/export".
  - A11.7: the business profile is exportable "via API export".
- **Build:** an async export job writes a ZIP (JSON per table, scoped to the org, secrets and
  tokens excluded, plus a manifest of signed asset URLs) to the assets bucket. There is a 7-day
  link and one export at a time per org.

```http
POST /api/studio/account/export { "include": ["projects","analytics","brand","image_library"] } → 202 { "export": { "id": "exp_1", "state": "QUEUED" } }
GET  /api/studio/account/export/exp_1 → 200 { "export": { "state": "READY", "downloadUrl": "…", "expiresAt": "…", "bytes": 48213 } }
```

- **Screens:** `/account/export`.
- **Tests:** worker (tenant isolation, no tokens) and API.

**15.E2 Business purge (internal)** — 1.5 d

- **Spec:**
  - §7.14: "PostMind Core emits org.deleted / business.deleted events".
  - A11.7: "on business deletion, profile is deleted within 30 days".
- **Missing:** only the organisation purge exists.
- **Build:** `POST /api/studio/internal/businesses/:id/purge { organisationId }` (X-Service-Token)
  soft-deletes the business's projects, brand kits, profile, scans and image library with a
  30-day grace. The 14.1 sweep is extended to hard-delete it.

```http
POST /api/studio/internal/businesses/biz_1/purge { "organisationId": "org_1" } → 202 { "purge": { "businessId": "biz_1", "graceUntil": "…", "projectsDeleted": 4 } }
```

- **Last step:** **Core team** calls it.

**15.E3 Inbound conversation attribution and engagement report** — 2 d

- **Spec:**
  - §8.8 `POST /api/studio/internal/publications/:id/attribute-conversation`, "Called by
    Engagement when a comment on a Studio-published video is received."
  - §15.4: "Which script hooks convert best to inbox leads?"
- **Missing:** the endpoint is absent. Only the outbound call to Engagement exists.
- **Build:**
  - A new table `publication_conversations` (publicationId, conversationId, kind, isLead,
    receivedAt), idempotent.
  - `GET /analytics/engagement-conversations?days=30` groups by project, hook and platform.

```http
POST /api/studio/internal/publications/pub_1/attribute-conversation { "organisationId": "org_1", "conversationId": "conv_9", "kind": "comment", "isLead": true } → 200 { "attributed": true }
```

- **Last step:** **Engagement team** calls it (report is empty until then).

**15.E4 Transparency report and compliance matrix** — 1.5 d

- **Spec:**
  - §18.5: "annually publish counts of content-safety blocks, takedown requests received, and
    platform-mandated removals."
  - §18.1: "maintain a compliance matrix documenting current scope, quota, and review status per
    platform."
- **Build:**
  - `GET /admin/transparency?year=2026` counts from safety_reviews, script-safety BLOCKs,
    publications TAKEN_DOWN and a new `takedown_requests` log (staff-entered, from policy@).
  - `ops/compliance-matrix.md`, generated from `PLATFORM_RULES` plus API versions and
    scopes, with a CI check that it is current.

**15.E5 Smart-preview share links (view only)** — 2 d

- **Spec:** §4.4: "public smart-preview links for approvals".
- **Build:** `POST /projects/:id/share-links { expiresInHours ≤ 168 }` creates an unguessable token
  (only its hash is stored) and a public page `/p/:token` with the variant players (signed
  preview URLs) and a comment box. Revocable. Approving from the link waits on decision P8.

```http
POST /api/studio/projects/prj_1/share-links { "expiresInHours": 72 } → 201 { "link": { "id": "sl_1", "url": "https://studio.postmind.ai/p/…", "expiresAt": "…" } }
```

- **Tests:** token security (hash only, expiry, revoked → 404) and no access beyond that project.

**15.E6 Editable style memory** — 1 d

- **Spec:** §10.4: "Users can view and edit their style memory".
- **Missing:** only view and delete (13.29).
- **Build:** `PATCH /businesses/:id/style-memory/:memoryId { value?, pinned?, disabled? }`. Pinned
  memories are not overwritten by the nightly job; disabled ones are not injected.
- **Tests:** API and build-style-memory job test.

**15.E7 Template management screen** — 1 d

- **Spec:** A5.4: "save custom slideshows as their own templates for reuse
  (studio.postmind.ai/templates)".
- **Build:** a `/templates` page listing org project and slideshow templates with delete
  (`DELETE /slideshow-templates/:id` added; `/templates/:id` DELETE exists).
- **Tests:** API and component.

**15.E8 Data-retention sweeps (§7.15)** — 2 d

- **Spec:** §7.15: provider_jobs "60 days full row, 12 months summary"; video_assets "30-day grace
  after project delete"; renders "90 days after project deletion"; approval_tasks "12 months
  after resolution".
- **Missing:** only video_analytics retention runs. 14.1 covers purged organisations only.
- **Build:** a daily `retention-sweep` job (dry-run admin preview like 14.1). Renders with a live
  publication are kept.
- **Tests:** DB tests per rule.

**15.E9 Secondary-region storage fallback** — 1.5 d

- **Spec:** §4.6: "Storage failures (S3 outage) fall back to a secondary region bucket."
- **Build:** `AssetStorage` gains a failover client (`S3_FALLBACK_REGION`, `S3_FALLBACK_BUCKET_*`)
  for writes, with the object location recorded, and reads try primary then fallback.
- **Last step:** **DevOps** creates the buckets and replication.

---

## 2. Blocked on a dependency (Wave B-style: contract now, 501 until unblocked)

| # | Spec reference | What is missing | Blocked on | Contract now | Days |
| --- | --- | --- | --- | --- | --- |
| 15.W1 | §8.8 "Called by PostMind Core when a user says make a video…"; §16.1 content library; A5.1 product showcase | `POST /internal/projects/from-content`; `POSTMIND_CONTENT` never fetches content (it is a label); product showcase from Core content | Core `GET /api/internal/content/:id` | route + `CoreContentClient` throwing NotImplementedError | 1.5 + 1 |
| 15.W2 | §16.1 "Studio reports usage events … via postmind-core.internal/api/internal/usage" | no usage events at all (CLAUDE.md: "Studio reports usage events") | Core usage API payload | outbox table + `UsageReporter` (pending_setup like 13.33) | 1.5 |
| 15.W3 | §16.1 "write shadow entries into PostMind Core's content calendar" | no calendar sync | Core calendar API | `CalendarShadowClient` + hooks on schedule/cancel/reschedule | 1.5 |
| 15.W4 | §7.14 "Nightly reconciliation job … org IDs that no longer exist in PostMind Core" | no org existence reconciliation or event subscription | Core list-organisations or event feed | job skipping with "waiting for Core", like 13.35 | 1.5 |
| 15.W5 | §16.3 "trigger type ON_VIDEO_PUBLISHED" (v1.1) | attribution payload lacks hashtags/project tags for Engagement triggers | Engagement trigger contract | add fields to the attribution call behind a flag | 0.5 |
| 15.W6 | §6.5 still-image fallback "Ideogram"; A11.4 "falls back to Ideogram or the closest stock match" | no Ideogram adapter; generation refusals don't fall to stock | Ideogram account/key (not in CLAUDE.md's confirmed list) | router slot; **the stock fallback on refusal is buildable now and goes into 15.B5** | 1.5 |

Sample (W1):

```http
POST /api/studio/internal/projects/from-content   (X-Service-Token)
{ "organisationId": "org_1", "userId": "usr_1", "businessId": "biz_1", "contentId": "post_77", "targetFormats": [{ "platform": "tiktok", "aspectRatio": "9:16", "durationSec": 30 }] }
→ 501 { "ok": false, "error": "not_implemented", "message": "waiting for Core content API (GET /api/internal/content/:id)" }
```

---

## 3. Needs a product decision

| # | Spec reference | Decision | Build once decided |
| --- | --- | --- | --- |
| P1 | §6.6/§12.6 "Enterprise customers may provide their own provider API keys" vs §2.5/§21.3, which defer "customer-BYOC provider keys" | ship BYOC in v1.0 or not; per-project override | per-org encrypted keys + registry per org: 4 d |
| P2 | §12.4 Enterprise "white-label"; §3.3 "white-labelled outputs"; A10.3 "white-label presets" | what white-label means (no Studio branding in UI? outputs?) | 2–3 d |
| P3 | §12.4 included quotas per tier, "TikTok + IG + 1 more" platforms on Basic | pricing (Playbook A-04 still open); enforce quotas in Studio or Core | quota counters + 402/403: 2 d (overage billing stays with Core) |
| P4 | §10.2 / §13.4 voice cloning tier (Playbook A-06, still open; code defaults ENTERPRISE) | Enterprise only, or Plus too | env change: 0 d |
| P5 | A14.3 / Playbook A-03 slideshow as the Basic default | yes / no | Create default by tier: 0.5 d |
| P6 | §20 "visible AI-generated disclosure toggle" | platform AI labels are always on (is_aigc, containsSyntheticMedia, is_ai_generated); add an opt-out toggle, an on-video label, or neither | 0.5–1 d |
| P7 | A3.6 step 3 "providers whose recent output was rated stylistically similar" (PROGRESS Phase 9 list) | what "rated" means (user ratings? retention?) | 2 d |
| P8 | §4.4 smart-preview "for approvals" | may an external, non-PostMind reviewer approve via the link (auth model)? | 1.5 d on top of 15.E5 |
| P9 | §3.1 "Nigerian Pidgin (via ElevenLabs custom)"; Playbook A-02 target markets | whether Nigeria is a launch market (custom voice work) | 1 d |

---

## 4. Implemented but deviating from the spec (not recorded in PROGRESS)

| # | Spec | As built | Fix |
| --- | --- | --- | --- |
| 1 | A11.1 unlicensed rows are rejected from search results | `/library/videos`, `/similar`, `/recommended` do not join `video_library_licenses` (only `/library/search` does) | 15.D7 (high: compliance) — **fixed** |
| 2 | §8.2 `publishPolicy: SCHEDULED` + `scheduledStartAt` | accepted and stored, never acted on | 15.A5 — **fixed** (approval schedules targets, staggered; drip queue) |
| 3 | §8.5 brand kit DELETE = "Soft-delete" | hard `brandKit.delete` (no `deletedAt`) | 15.B1 — **fixed (Track B)** |
| 4 | §9.3 "truncate at 2200 chars, warn user" | over-long captions → 400 | 15.A9 — **fixed** (manual stays 400; Studio-sent captions truncated + metadata.captionTruncated; recorded in PROGRESS) |
| 5 | §9.4 "quotaExceeded → back off to next quota window" | terminal, non-retryable failure | 15.A9 — **fixed** (deferred to the next Pacific-midnight reset) |
| 6 | §9.1 Instagram Reel "≤90s, ≤1GB" | 900 s / 300 MB from current Meta docs | record only |
| 7 | §5.5 voiceover fitted to shot ±5% | voice clip cut at shot length | 15.B3 — **fixed (Track B)** |
| 8 | §5.5 "one of five pre-selected … voices matched to … tone" | single `ELEVENLABS_DEFAULT_VOICE_ID` | 15.B3 — **fixed (Track B)** |
| 9 | A10.4 slideshow default `costBudgetPence` £1.50 | short-form default £3.50 (operator decision 2 did not mention slideshows) | 15.D2 — **fixed** (slideshow default 150p) |
| 10 | A12.4 feature flags | `FEATURE_*_ENABLED` in `.env.example`, unread by code | 15.D1 — **fixed** |
| 11 | §5.8 / §3.1 per-format presets, 24/30/60 fps, 720p drafts, 4K | fixed 1080 + one fps for all outputs | 15.B7 — **fixed (Track B)** |
| 12 | §5.2 GPT-4o fallback | router lists `openai` for text_generation; adapter lacks the capability, so no fallback exists | 15.C1 — **fixed** (Responses API text + whisper-1 fallbacks) |
| 13 | A6.5 IMAGE_STILL uses the image library first; generated images kept | always generates; not stored in the library | 15.B5 — **fixed (Track B)** |
| 14 | §10.4 style memory "view and edit" | view + delete only | 15.E6 — **fixed** (PATCH style memory: value / pinned / disabled) |
| 15 | §3.1 / §9.1 Facebook "Reels + feed" (8 destinations) | Reels only (7 destinations; noted only in a code comment) | 15.A1 — **fixed** (instagram_feed, facebook_feed) |
| 16 | A3.3 "per-frame perceptual hash for dedup" of corpus | content SHA of the source file | record only |
| 17 | §13.1 caption_sync / audio_sync / watermark / brand_kit | recorded as `not_run` (PROGRESS [3.7] says so, but no phase plans them) | 15.B2 — **fixed (Track B)** |

---

## 5. Parallel tracks and file ownership

| Track | Items | Days | Owns (others must not edit) |
| --- | --- | --- | --- |
| **A Publishing** | A1–A9 | 17.5 | `src/lib/studio/platforms/**`, `services/publications.ts`, `services/publication-reschedule.ts`, `queue/workers/publish-video.ts`, new `queue/workers/generate-thumbnail.ts`, `automation/outbox.ts`, `automation/auto-publish.ts`, `overlays/suggest.ts`, new `overlays/voice-captions.ts`, `analytics/best-times.ts` (new), `components/studio/{review/publish-panel,review/variant-card,publications,calendar}/**`, routes `publications/**`, `renders/[id]/thumbnail`, `renders/[id]/captions`, `businesses/[id]/drip-queue`, `projects/[id]/caption-suggestions`, `analytics/best-times` |
| **B Composition & media** | B1–B9 | 17.5 | `pipeline/edl.ts`, `pipeline/quality-checks.ts`, `pipeline/music.ts`, `pipeline/mastering.ts`, `queue/workers/{generate-asset,compose-video,run-quality-gate}.ts`, `services/brand-kits.ts`, `services/uploads.ts`, `components/studio/business/brand-kit*`, `components/studio/review/{quality-panel,paused-notes}.tsx` |
| **C Planning & providers** | C1–C9 | 13 | `pipeline/{scripting,ideation,script-safety,provider-run}.ts`, `providers/{openai,router,default-registry}.ts`, new `providers/storyblocks-music.ts`, `queue/workers/{plan-project,regenerate-script}.ts`, `queue/worker-host.ts` (C3 deferral), `services/{projects,scripts,voice-profiles}.ts`, `components/studio/create/**` |
| **D Governance & admin** | D1–D10 | 20.5 | `src/lib/studio/system-flags.ts`, new `services/{features,tier-gates,approval-workflows,dead-letter}.ts`, `automation/approval.ts`, `services/kill-switch-admin.ts`, `services/library.ts`, `cost/project-budget.ts`, `services/{scans,image-library,overlays}.ts` (gates only), `scan/classify.ts`, `observability/metrics.ts`, `ops/**`, `src/app/api/studio/admin/**`, `components/studio/admin/**`, `test/visual/**`, `test/eval/**` |
| **E Data rights & integrations** | E1–E9 + W1–W5 contracts | 15.5 (+ 6.5 contracts) | `src/app/api/studio/internal/**`, new `src/app/api/studio/account/**`, `projects/[id]/share-links`, new `/p/[token]` page, `services/organisation-purge.ts` (+ business purge), new `services/{export,share-links,retention}.ts`, `services/style-memory.ts`, `storage.ts`, `src/lib/studio/core/**`, `components/studio/{business/style-memory-panel,templates}/**` |

**Cross-track contracts** (agree up front; one migration file per track, expand-only):

- C5 adds `video_projects.language` and sets `video_scripts.language`. B3 and A4 read it.
- A5 schedules through the D3 step machine only via `approveProject()`'s return value. D3 must
  keep that signature.
- C4's workflow picker reads D3's `GET /approval-workflows`. It ships behind an empty list until
  D3 lands.
- W1's planner change in `plan-project.ts` is done by Track C after E ships the client.
- B5 adds the stock fallback on generation refusal (the buildable half of W6).

**Definition of done** (as in Phases 13/14):

- A unit test per service.
- API tests for auth, validation, tenant isolation and audit.
- A sample handler in `demo/api/handlers`.
- UI where a screen is listed.
- Updates to PROGRESS, BACKLOG and the register. The register gains W1–W6 and P1–P9, and
  13.38's Storyblocks footage and Pexels video move to "buildable".
- A security review for tracks D and E: share tokens, export, internal endpoints and two-person
  kill.
- Green CI.

---

## Appendix A — out of scope per CLAUDE.md "What not to build" (excluded)

| Spec reference | Item | Rule |
| --- | --- | --- |
| §5.7, §2.4, Playbook A-07 | Remotion self-hosted composer | "Do not build the video composition rendering itself" |
| §12.4 "Overage is billed at cost + 30% margin" | overage invoicing | "Do not build the payment / billing system" (Studio only reports usage, 15.W2) |
| §12.6 "£99/month per BYOC provider" | BYOC platform-fee billing | same billing rule (BYOC itself is decision P1) |
| §9.3 / §16.3 Studio-side Meta connect | Meta OAuth in Studio | "Do not build the Engagement Meta OAuth flow" (already honoured) |

## Appendix B — deferred by the spec itself (not gaps)

These are v1.1+/v1.2 per §2.5, §3.2, §21.3 or the Addendum:

- Threads, Pinterest and Snapchat publishing
- live-stream automation
- podcast-to-video
- cross-language dubbing
- A/B testing of hooks and thumbnails
- long-form-to-shorts repurposing of uploads (Opus-Clip style)
- fine-tuning of ideation/script models
- an EU-only provider tier (§18.4 "explore for v1.1")
- a Content ID check for uploaded music (A11.6 "v1.2")
- interactive/shoppable video and VR/AR (§3.2)
- self-hosted Whisper/MusicGen "for scale"

Not needed:

- Twelve Labs, because ingestion was built in-house (A9.2).
- Synthesia, Tavus and Pika, which are listed in §6.2–6.3 but absent from the §6.4 router.

## Appendix C — people and process (no code; tracked outside this phase)

- The `policy@postmind.ai` mailbox (§18.5). 15.E4 gives staff a log for what arrives there.
- Legal review of licence assertions before new corpus sources (A11.1).
- The annual licence-copy review (§18.2).
- The DPA disclosure of US processing (§18.4).
- Playbook fixtures H-01…H-08, which feed 15.D10.
