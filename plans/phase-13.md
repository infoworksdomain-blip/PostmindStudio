# Phase 13 — build the "Not built yet" register

The source is the 47-item register in `demo/tour/not-built-data*.ts` (the demo's `#/tour/not-built`
page). This plan turns it into a build order, with every new endpoint's contract and a sample
request/response.

**Sample endpoints: what that means here.** CLAUDE.md rule 4 forbids production code that returns
made-up data. So every endpoint below is a real route: zod-validated, authenticated
(`withStudioRoute`, or `withInternalRoute` for service calls), tenant-scoped, audited on
mutations, with unit and API tests.

- **Wave A** items are fully implemented.
- **Wave B** items are blocked on something outside Studio. Their endpoints still exist with the
  final contract, but return `501 { error: "not_implemented", message: "<what it waits for>" }`
  until the dependency lands. They never return fake data.
- **Wave C** is operator and staging work.
- **Demo:** every new endpoint also gets a sample handler in `demo/api/handlers`, so the demo
  shows each feature with sample data.

Envelopes follow the existing API: success is `{ ok: true, ... }`. Errors are
`{ ok: false, error, message, details? }`.

---

## Wave A — buildable now (5 parallel tracks)

### A1 · Create and review (≈ 22 days)

**13.1 Script edit and regenerate** (spec 8.3–8.4)

```http
PATCH /api/studio/scripts/:id
{ "fullText": "Friday. Three new small plates…", "shots": [{ "id": "shot_2", "voiceoverText": "…", "onScreenText": "20% off" }] }
→ 200 { "script": { "id": "scr_1", "fullText": "…", "shots": [ … ] }, "staleRenders": ["rnd_1"] }
```

```http
POST /api/studio/scripts/:id/regenerate
{ "instruction": "Punchier hook, mention the Saturday class" }
→ 202 { "project": { "id": "prj_1", "state": "PLANNING" }, "runId": "run_9" }
```

Editing narration marks the affected shots for voice-only regeneration. Regenerating starts a new
run from Layer 2, reusing the Layer 1 brief.

**13.2 Shot swap and delete** (spec 14.2)

```http
PATCH /api/studio/shots/:id
{ "imageLibraryId": "img_42" }  // or { "assetId": "ast_7" }
→ 200 { "shot": { "id": "shot_3", "assetId": "ast_new", "state": "READY" }, "staleRenders": ["rnd_1","rnd_2"] }
```

```http
DELETE /api/studio/shots/:id
→ 200 { "script": { "id": "scr_1", "targetDurationSec": 26, "shots": [ … ] } }   // 409 if it's the last shot
```

**13.3 Whole-video overlays**

```http
GET /api/studio/renders/:id/overlays
→ 200 { "data": [{ "id": "ovl_9", "text": "@leedssourdough", "startSec": 0, "endSec": 30, "style": { … } }] }
```

**13.4 Per-slide overlays.** The migration adds `text_overlays.slideId`.

```http
GET  /api/studio/slides/:id/overlays → 200 { "data": [ … ] }
POST /api/studio/slides/:id/overlays { "presetId": "pre_hook_1", "text": "Bake #3" } → 201 { "overlay": { … } }
```

**13.5 Upload your own video** (sourceType UPLOAD) **and clip upload**

```http
POST /api/studio/uploads
{ "kind": "source_video", "contentType": "video/mp4", "sizeBytes": 48211000, "fileName": "shop-tour.mp4" }
→ 201 { "upload": { "id": "upl_1", "putUrl": "https://…signed", "expiresAt": "…", "maxBytes": 524288000 } }
```

```http
POST /api/studio/uploads/:id/complete → 200 { "asset": { "id": "ast_20", "durationSec": 41.2, "width": 1080, "height": 1920 } }
POST /api/studio/projects { "sourceType": "UPLOAD", "uploadId": "upl_1", "targetFormats": [ … ] } → 201
```

The pipeline's UPLOAD path skips Layers 1–3 and still runs captions, overlays, multi-format
output and the quality gate.

**13.6 Word-level caption timing.** There is no endpoint. The pipeline transcribes narration
with the existing AssemblyAI adapter, stores word timings on the asset, and karaoke overlays use
them.

**13.7 Overlay editor polish.** UI only: resize handles, undo and redo, colour transparency,
per-platform safe-area guides, and editing presets.

### A2 · Library, manage and business set-up (≈ 21 days)

**13.8 Free-text library search**

```http
POST /api/studio/library/search { "q": "moody 5am bakery pov", "categorySlug": "food-drink", "limit": 24, "cursor": null }
→ 200 { "data": [{ "id": "lib_1", "title": "POV: 5am…", "similarity": 0.83, "thumbnailUrl": "…" }], "nextCursor": "…" }
```

This combines pgvector search on an embedding of the query with a keyword boost on the title and
tags.

**13.9 Calendar drag-to-reschedule** (spec 14.3)

```http
PATCH /api/studio/publications/:id { "scheduledFor": "2026-10-03T08:30:00Z" }
→ 200 { "publication": { "id": "pub_1", "state": "SCHEDULED", "scheduledFor": "…" } }   // 409 unless SCHEDULED; 1 min – 180 days
```

The delayed job is replaced atomically.

**13.10 Scheduled website rescans and stock refresh** (A6.6)

- The migration adds `website_scans.etag` and `website_scans.lastModified`.
- BullMQ job schedulers run a rescan every 30 days and a stock refresh weekly. A rescan is
  skipped when the site is unchanged.

```http
GET /api/studio/businesses/:id/scans/schedule → 200 { "nextScanAt": "…", "nextStockRefreshAt": "…", "lastSkippedUnchangedAt": null }
```

**13.11 DNS TXT ownership verification** (A6.7, Enterprise)

```http
POST /api/studio/businesses/:id/domain-verification { "domain": "leedssourdough.co.uk" }
→ 201 { "verification": { "id": "dv_1", "record": "_postmind-studio.leedssourdough.co.uk", "value": "pm-studio-verify=7f3c…", "state": "PENDING" } }
GET  /api/studio/businesses/:id/domain-verification → 200 { "verification": { "state": "VERIFIED", "verifiedAt": "…" } }
```

A poll job checks the TXT record with DNS lookups. If ownership is disputed, a job purges the
scanned data after 24 h.

**13.12 Perceptual image de-duplication.** There is no endpoint. Ingest computes a dHash with
`sharp`, the migration adds `image_library.phash`, and near-duplicates (Hamming distance ≤ 6) are
skipped.

**13.13 Voice profiles** (ElevenLabs voice cloning, from their documented API)

```http
POST /api/studio/voice-profiles  (multipart: name, consent=true, samples[] audio ≤ 10 MB each)
→ 201 { "voiceProfile": { "id": "vp_1", "name": "Amara (owner)", "state": "READY", "provider": "elevenlabs" } }
GET    /api/studio/voice-profiles?businessId= → 200 { "data": [ … ] }
DELETE /api/studio/voice-profiles/:id → 200 { "deleted": true }   // also deletes the provider voice
POST   /api/studio/voice-profiles/:id/preview { "text": "Fresh bread every Friday" } → 200 { "previewUrl": "…" }
```

Consent is required, recorded and audited.

**13.14 Onboarding first-run flow** (spec 14.5)

```http
GET   /api/studio/onboarding → 200 { "onboarding": { "step": "brand_kit", "completed": ["connect"], "firstVideoProjectId": null } }
PATCH /api/studio/onboarding { "completed": ["connect","brand_kit"], "step": "first_video" } → 200 { … }
POST  /api/studio/brand-kits/extract (multipart: logo) → 200 { "palette": ["#2B1D14","#C6452D","#F3E7D3"], "suggestedFont": null }
```

The palette is extracted with `sharp`. The UI is a `/welcome` wizard: Connect, then Brand kit,
then First video, then Celebrate.

**13.15 Corpus ingestion follow-ups**

```http
POST /api/studio/admin/library/ingest/resubmit { "runIds": ["run_a"], "failedOnly": true } → 202 { "queued": 12, "skipped": 0 }
```

Sources are also streamed straight to S3 with a multipart upload instead of being buffered in
memory.

### A3 · Admin, automation and cost (≈ 21 days)

**13.16 Queue and provider health.** Circuit-breaker state moves to Redis, so every process
shares it.

```http
GET /api/studio/admin/queues → 200 { "queues": [{ "name": "studio-assets", "waiting": 14, "active": 5, "failed": 2, "delayed": 0, "oldestWaitingSec": 41 }] }
GET /api/studio/admin/providers → 200 { "providers": [{ "id": "runway", "breaker": "closed", "errorRate1h": 0.02, "spendTodayPence": 1840, "healthy": true }] }
```

**13.17 Content-safety review queue** (spec 16.4). Script-safety and content-safety results of
REVIEW now pause the run and create a review, instead of failing it.

```http
GET  /api/studio/admin/safety-reviews?state=PENDING → 200 { "data": [{ "id": "sr_1", "projectId": "prj_1", "kind": "content", "reason": "yes_alcohol 0.83", "previewUrl": "…" }] }
POST /api/studio/admin/safety-reviews/:id/decision { "decision": "ALLOW", "note": "Cider in a bakery context" }
→ 200 { "review": { "state": "ALLOWED" }, "project": { "state": "READY_FOR_REVIEW" } }
```

This needs `studio:admin:moderation` and a platform staff account. ALLOW resumes the run; BLOCK
fails it with the note.

**13.18 Per-organisation policy.** The migration adds `org_policies`.

```http
GET /api/studio/admin/organisations/:id/policy → 200 { "policy": { "defaultReviewPolicy": "REQUIRE_APPROVAL", "autoApproveTrustThreshold": 10, "autoApproveAllowed": true } }
PUT /api/studio/admin/organisations/:id/policy { "autoApproveAllowed": false } → 200 { … }
```

**13.19 Per-organisation cost cap overrides.** The migration adds `org_cost_caps`.

```http
PUT /api/studio/admin/organisations/:id/cost-caps { "dailyPence": 20000, "monthlyPence": 100000, "reason": "Pilot, agreed with Commercial" }
→ 200 { "caps": { "daily": { "pence": 20000, "source": "org_override" }, "monthly": { … } } }
```

**13.20 Auto-resume paused projects.** A rollover job at 00:05 UTC (and on the 1st of the month)
re-runs projects paused by the organisation's daily or monthly cap, through the existing re-drive
service. There is no endpoint; the project sets `metadata.autoResume` (default on).

```http
PATCH /api/studio/projects/:id { "autoResume": false } → 200
```

**13.21 Auto-publish outbox and retry.** Outbox rows are written in the same transaction as the
approval, and a dispatcher job sends them with retry.

```http
GET  /api/studio/projects/:id/auto-publish → 200 { "outbox": [{ "target": { "platform": "tiktok" }, "state": "FAILED", "attempts": 3, "lastError": "…" }] }
POST /api/studio/projects/:id/auto-publish/retry → 202 { "requeued": 1 }
```

**13.22 Organisation purge** (internal, mirrors Engagement 14.13)

```http
POST /api/studio/internal/organisations/:id/purge   (X-Service-Token)
→ 202 { "purge": { "organisationId": "org_1", "channelsWiped": 2, "graceUntil": "2026-10-28T…" } }
```

Tokens are wiped immediately and the rest of the data is soft-deleted with a 30-day grace period.

**13.23 Milestone notifications** (spec 14.4). There is no endpoint. The analytics poller raises
"10k views" and "100 comments" notifications once per publication per threshold.

**13.24 Notification preferences.** Email delivery itself is Wave B.

```http
GET   /api/studio/notification-preferences → 200 { "preferences": { "generation_complete": { "inApp": true, "email": false }, … } }
PATCH /api/studio/notification-preferences { "publication_failed": { "email": true } } → 200 { … }
```

### A4 · Pipeline, media and analytics (≈ 20 days)

**13.25 Hive async moderation for videos longer than 90 s**, using Hive's documented async API.

```http
POST /api/studio/webhooks/hive   (Hive callback; verified signature or shared secret, per Hive's docs)
→ 200 { "received": true }   // resumes run-quality-gate for that render
```

**13.26 Loudness normalisation** (−14 LUFS target) **and an H.264 re-encode for compatibility**.
This is an ffmpeg pass after compose; there is no endpoint.

**13.27 Sound effects.** A Storyblocks audio adapter, driven by SFX cues from Layer 2, adds audio
clips to the edit decision list. There is no new endpoint; the review response gains
`metadata.sfx`.

**13.28 Deeper analytics.** YouTube Analytics retention curves and demographics, plus the
LinkedIn reader behind its existing flag.

```http
GET /api/studio/analytics/publications/:id → (existing) + { "retention": [{ "atPct": 0.25, "watchingPct": 0.71 }], "demographics": [{ "ageGroup": "25-34", "pct": 38.2 }] }
```

**13.29 Style memory.** A nightly job builds style memory from the signals that exist today
(YouTube retention, what got approved or rejected, what was regenerated). Sentiment is Wave B.

```http
GET    /api/studio/businesses/:id/style-memory → 200 { "data": [{ "id": "sm_1", "signalType": "hook_timing", "value": "hook in first 1.2 s", "reason": "Top 3 videos by retention" }] }
DELETE /api/studio/businesses/:id/style-memory/:memoryId → 200 { "deleted": true }
```

**13.30 CDN signed URLs.** A CloudFront signer sits behind the storage interface. It is used when
`CDN_URL` and the key pair are configured; otherwise S3 presigned URLs are used as now.

**13.31 Weekly cost regression and a daily platform canary.** These are scheduled CI workflows.
The canary runs only when sandbox secrets are present.

### A5 · Fallback providers with active accounts (≈ 6 days)

**13.32 Luma adapter** (AI_CLIP fallback for Runway) **and HeyGen adapter** (AI_AVATAR), both
built from the providers' current documentation. There are no endpoints; the router gains real
fallbacks.

---

## Wave B — blocked on something outside Studio (contracts now, 501 until unblocked)

| Item | Endpoint / component | Returns until unblocked | Unblocked by |
| --- | --- | --- | --- |
| 13.33 Email delivery | `EmailSender` (Core adapter) | preferences stored; email marked "pending setup" | Core email API, or a decision that Studio sends email itself (Resend/SES) |
| 13.34 Business list | `GET /api/studio/businesses` | `501 waiting for Core list-businesses` | Core `GET /api/internal/organisations/:id/businesses` |
| 13.35 Meta channel reconciliation | daily job + `GET /api/studio/admin/channels/reconciliation` | `501 waiting for Core list-channels` | Core list-channels endpoint |
| 13.36 BPM/key, CLIP/CLAP | analysis provider adapter | adapter reports unhealthy (never selected) | an inference host decision |
| 13.37 Browser-render scan fallback | headless-render adapter | scan falls back to manual entry, as now | a headless Chromium host |
| 13.38 Other fallback providers (Kling, Veo, fal, Replicate, D-ID, Pexels, Azure Speech, Creatomate, Sightengine) | one adapter each | not registered (no key) | accounts and keys |
| 13.39 Sentiment in style memory | Engagement classifier client | `501 waiting for Engagement` | Engagement sentiment API |

## Wave C — staging and people

Work through these in order:

1. Core Meta wiring.
2. Deploy Prometheus and Alertmanager.
3. Live provider and posting runs.
4. Kill-switch and rollback rehearsals.
5. k6 smoke and full runs.
6. The point-in-time restore drill.
7. The 100-video corpus sample, operator review, then the full run.
8. S3 lifecycle rules in the infrastructure repo.
9. Beta onboarding, the on-call rota and the Trust & Safety audit.

These close BACKLOG 9.2, 9.3, 12.2, 12.3, 12.5 and GATE 12.

## Order and definition of done

- **Order:** Wave A tracks A1–A5 run in parallel. Wave B contracts ship alongside them. Wave C
  runs as soon as staging exists.
- **Done** means every endpoint has:
  - a unit test for its service, and an API test for auth, validation, tenant isolation and
    audit;
  - a sample handler in the demo;
  - a UI where the register lists a screen.
- Every track also passes a security review, full CI, and gets PROGRESS/BACKLOG updates.
- Migrations are expand-only; the CI table count goes up by one per new table.
