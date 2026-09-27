import type { NotBuiltItem } from './not-built-types';

// Product features not built yet (screens and the endpoints behind them). Sources are the review
// lists and "NOT BUILT" notes in PROGRESS.md, runbook GAP lines, NotImplementedError uses in src,
// and spec §14 compared with the screens that exist. Estimates are Studio-side engineering days.

export const PRODUCT_GAPS: NotBuiltItem[] = [
  // ------------------------------------------------------------------ Notifications
  {
    id: 'email-notifications',
    group: 'Notifications',
    title: 'Email notifications',
    blocker: 'blocked on a dependency',
    why: 'Spec 14.4 wants email for generation complete, approval pending > 2 h, publication failed and the 80% monthly cap. No PostMind Core notification or email API is documented, so only in-app plus a signed webhook exist; the bell says so.',
    source: 'PROGRESS [12.x notify], [OPS-caps]; runbooks/README.md GAP',
    plan: {
      screens: ['Notification preferences (per kind: in-app / email; Slack opt-in)'],
      endpoints: [
        'EmailSender behind NotificationSender (Core API or Resend/SES adapter)',
        'GET|PATCH /api/studio/notification-preferences',
        'migration: notification_preferences',
      ],
      days: 4,
      dependsOn: 'Core decision: a Core email API, or Studio sends email itself',
    },
  },
  {
    id: 'milestone-notifications',
    group: 'Notifications',
    title: 'Milestone notifications (10k views, 100 comments)',
    blocker: 'not started',
    why: 'Listed in spec 14.4; no event raises it. Analytics snapshots exist, so this is a threshold check after each poll.',
    source: 'spec 14.4 vs notifications/events.ts',
    plan: {
      screens: ['Bell entry + link to the publication’s analytics'],
      endpoints: [
        'milestone check in poll-publication-analytics (dedupe key per publication + threshold)',
      ],
      days: 1.5,
      dependsOn: 'none',
    },
  },
  // ------------------------------------------------------------------ Create and review
  {
    id: 'onboarding',
    group: 'Create and review',
    title: 'Onboarding first-run flow (spec 14.5)',
    blocker: 'not started',
    why: 'Only the pre-seeded “Introduce yourself and what you do” template exists. There is no first-run wizard (connect platforms → brand kit in 3 clicks → first video → “You just went live” celebration).',
    source: 'spec 14.5 vs src/components/studio',
    plan: {
      screens: [
        '/welcome wizard: Connect, Brand kit (logo upload + colour extraction), First video (template), Celebrate',
      ],
      endpoints: [
        'POST /api/studio/brand-kits/extract (palette from logo)',
        'onboarding state per user (GET|PATCH /api/studio/onboarding)',
      ],
      days: 5,
      dependsOn: 'an image decoder for palette extraction (sharp)',
    },
  },
  {
    id: 'script-edit',
    group: 'Create and review',
    title: 'Script edit and regenerate',
    blocker: 'missing endpoint',
    why: 'Spec 8.3–8.4 PATCH /scripts/:id and script regenerate were not built; only shot-level edit/regenerate exists, so the Script tab is read-only.',
    source: 'PROGRESS Phase 4 review list',
    plan: {
      screens: ['Editable Script tab with “Regenerate script”'],
      endpoints: [
        'PATCH /api/studio/scripts/:id',
        'POST /api/studio/scripts/:id/regenerate (new run from Layer 2)',
      ],
      days: 3,
      dependsOn: 'none',
    },
  },
  {
    id: 'shot-swap-delete',
    group: 'Create and review',
    title: 'Shot asset swap and delete',
    blocker: 'missing endpoint',
    why: 'Spec 14.2 asks to swap a shot’s asset from the library or delete the shot; there is no endpoint for either.',
    source: 'PROGRESS Phase 10 review list',
    plan: {
      screens: ['Shot strip: “Swap from library” picker, “Delete shot” with confirm'],
      endpoints: [
        'PATCH /api/studio/shots/:id { assetId | imageLibraryId }',
        'DELETE /api/studio/shots/:id (re-times the script, marks renders stale)',
      ],
      days: 3,
      dependsOn: 'none',
    },
  },
  {
    id: 'whole-video-overlays',
    group: 'Create and review',
    title: 'Whole-video overlay listing',
    blocker: 'missing endpoint',
    why: 'Whole-video overlays attach to a render and can be bulk-created, but no endpoint lists them, so the editor cannot show or edit them.',
    source: 'PROGRESS Phase 10 review list',
    plan: {
      screens: ['Overlay editor: “Whole video” lane'],
      endpoints: ['GET /api/studio/renders/:id/overlays'],
      days: 1,
      dependsOn: 'none',
    },
  },
  {
    id: 'word-timing',
    group: 'Create and review',
    title: 'Word-level caption timing',
    blocker: 'not started',
    why: 'Karaoke captions spread words evenly across the overlay; word timing needs the narration transcribed (AssemblyAI) inside the pipeline.',
    source: 'PROGRESS Phase 8 review list',
    plan: {
      screens: [],
      endpoints: [
        'transcribe narration per shot after Layer 4 (assemblyai adapter exists)',
        'store word timings on video_assets.metadata; prerender karaoke from them',
      ],
      days: 3,
      dependsOn: 'ASSEMBLYAI_API_KEY in the pipeline environment',
    },
  },
  {
    id: 'upload-source',
    group: 'Create and review',
    title: 'Upload your own video (UPLOAD source) and clip upload',
    blocker: 'missing endpoint',
    why: 'plan-project throws NotImplementedError for sourceType UPLOAD, and VIDEO_CLIP slides can only reuse an existing asset: there is no clip upload endpoint.',
    source: 'queue/workers/plan-project.ts; PROGRESS Phase 7 review list',
    plan: {
      screens: ['Create: “Upload a video”; slide editor: upload a clip'],
      endpoints: [
        'POST /api/studio/uploads (presigned S3 PUT, size/type limits)',
        'plan-project UPLOAD path (skip Layers 1–3, caption + overlays + multi-format)',
      ],
      days: 5,
      dependsOn: 'none',
    },
  },
  {
    id: 'overlay-editor-polish',
    group: 'Create and review',
    title: 'Overlay editor: resize handles, undo, alpha, safe areas, editable presets',
    blocker: 'not started',
    why: 'Simplifications recorded when the editor shipped: sliders instead of handles, no undo history, no alpha in the colour input, no platform safe-area guides, presets not editable in the UI (the PATCH endpoint exists).',
    source: 'PROGRESS Phase 10 review list',
    plan: {
      screens: ['Overlay editor'],
      endpoints: ['none (PATCH /overlay-presets/:id exists)'],
      days: 4,
      dependsOn: 'none',
    },
  },
  {
    id: 'slide-overlays',
    group: 'Create and review',
    title: 'Per-slide text overlays',
    blocker: 'not started',
    why: 'Overlays attach to shots or renders; the schema has no slide → overlay link, so slides use their built-in text and template overlayDefaults are not applied to slides.',
    source: 'PROGRESS Phase 8 review list',
    plan: {
      screens: ['Slide editor: overlay panel'],
      endpoints: ['migration: text_overlays.slideId', 'GET|POST /api/studio/slides/:id/overlays'],
      days: 3,
      dependsOn: 'none',
    },
  },
  // ------------------------------------------------------------------ Library and images
  {
    id: 'library-search',
    group: 'Library and images',
    title: 'Free-text library search',
    blocker: 'missing endpoint',
    why: 'The search box only filters the page already loaded (and says so): GET /library/videos has category, tag, length and mood filters but no text query.',
    source: 'PROGRESS Phase 10 review list',
    plan: {
      screens: ['/library search box queries the server'],
      endpoints: [
        'POST /api/studio/library/search { q } (embed the query, pgvector nearest + keyword boost, cursor)',
      ],
      days: 2,
      dependsOn: 'corpus ingested for useful results',
    },
  },
  {
    id: 'bpm-clip-clap',
    group: 'Library and images',
    title: 'BPM / key detection, CLIP visual and CLAP audio embeddings',
    blocker: 'blocked on a dependency',
    why: 'No provider in the stack: BPM and key need librosa/Essentia (Python); CLIP/CLAP need a model host. bpm and key are null and similarity is one text-embedding distance.',
    source: 'PROGRESS Phase 9 review list, GATE 12 list',
    plan: {
      screens: ['Library detail: BPM, key; “Similar look / similar sound” shelves'],
      endpoints: [
        'Python analysis worker (librosa + open_clip + CLAP) behind a provider adapter',
        'migration: visual/audio embedding columns',
        're-analysis job for ingested items',
      ],
      days: 8,
      dependsOn: 'a GPU/CPU inference host decision',
    },
  },
  {
    id: 'style-memory',
    group: 'Library and images',
    title: 'Style memory (learn from retention)',
    blocker: 'blocked on a dependency',
    why: 'The style_memories table exists but nothing writes it: only YouTube reports average watch %, and comment sentiment needs Engagement’s classifier API.',
    source: 'PROGRESS Phase 11 review list; GATE 1 list',
    plan: {
      screens: ['Business: “What Studio has learned” with reasons and delete'],
      endpoints: [
        'nightly style-memory job from analytics',
        'GET|DELETE /api/studio/businesses/:id/style-memory',
        'Layer 1–2 prompt supplement',
      ],
      days: 6,
      dependsOn: 'Engagement sentiment API; more platforms reporting retention',
    },
  },
  {
    id: 'corpus-tooling',
    group: 'Library and images',
    title: 'Corpus ingestion follow-ups',
    blocker: 'not started',
    why: 'Sources are buffered in memory (≤ 200 MB × concurrency) instead of streamed to S3; there is no admin UI to resubmit failed items (use the CLI).',
    source: 'PROGRESS [OPS-corpus]; runbooks/corpus-ingestion.md GAP',
    plan: {
      screens: ['Admin → Library: “Resubmit failures”'],
      endpoints: [
        'streaming download → multipart S3 upload in ingest.ts',
        'POST /api/studio/admin/library/ingest/resubmit',
      ],
      days: 3,
      dependsOn: 'none',
    },
  },
  {
    id: 'image-dedup',
    group: 'Library and images',
    title: 'Perceptual image de-duplication',
    blocker: 'not started',
    why: 'Fingerprints are sha256 of the bytes, so resized or re-encoded copies are not deduplicated.',
    source: 'PROGRESS Phase 6 review list',
    plan: {
      screens: [],
      endpoints: ['dHash on ingest (sharp) + migration for the hash column'],
      days: 1.5,
      dependsOn: 'sharp in the image',
    },
  },
  // ------------------------------------------------------------------ Manage
  {
    id: 'calendar-drag',
    group: 'Manage',
    title: 'Calendar drag-to-reschedule',
    blocker: 'missing endpoint',
    why: 'Spec 14.3 wants drag to reschedule; a scheduled publication can only be cancelled and created again.',
    source: 'PROGRESS Phase 10 review list',
    plan: {
      screens: ['Calendar: draggable scheduled posts (keyboard alternative: “Move to…”)'],
      endpoints: [
        'PATCH /api/studio/publications/:id { scheduledFor } (replace the delayed job atomically)',
      ],
      days: 2,
      dependsOn: 'none',
    },
  },
  {
    id: 'business-list',
    group: 'Manage',
    title: 'Business list and picker',
    blocker: 'blocked on a dependency',
    why: 'Core has no list-businesses endpoint, so the header switcher takes a typed business id and Studio cannot verify a business belongs to the organisation.',
    source: 'PROGRESS Phase 10 review list; Phase 4 review list',
    plan: {
      screens: ['Header business switcher as a searchable list'],
      endpoints: [
        'Core: GET /api/internal/organisations/:id/businesses',
        'Studio: cached proxy GET /api/studio/businesses + validation on writes',
      ],
      days: 2,
      dependsOn: 'Core team adds the endpoint',
    },
  },
  {
    id: 'analytics-depth',
    group: 'Manage',
    title: 'Deeper analytics (retention, demographics, LinkedIn, TikTok watch time)',
    blocker: 'blocked on a dependency',
    why: 'No reader fetches retention curves or demographics yet; LinkedIn needs the vetted Community Management API; TikTok watch time only exists in the TikTok API for Business.',
    source: 'PROGRESS Phase 11 review list; analytics/fetchers.ts NotImplementedError',
    plan: {
      screens: ['Publication analytics: retention curve, audience'],
      endpoints: [
        'YouTube Analytics retention/demographics reports',
        'LinkedIn reader enabled via LINKEDIN_POST_ANALYTICS',
      ],
      days: 4,
      dependsOn: 'LinkedIn product approval; TikTok for Business app',
    },
  },
  // ------------------------------------------------------------------ Business set-up
  {
    id: 'scheduled-rescans',
    group: 'Business set-up',
    title: 'Scheduled website rescans and stock refresh',
    blocker: 'not started',
    why: 'A6.6 asks for 30-day rescans, a weekly stock delta and skip-if-unchanged; only manual scan and refresh exist, and website_scans has no ETag column.',
    source: 'PROGRESS Phase 6 review list',
    plan: {
      screens: ['Business → Website scan: next scheduled scan'],
      endpoints: [
        'BullMQ job schedulers on studio-assets',
        'migration: website_scans.etag / lastModified',
      ],
      days: 2,
      dependsOn: 'none',
    },
  },
  {
    id: 'dns-verification',
    group: 'Business set-up',
    title: 'DNS TXT ownership verification (Enterprise)',
    blocker: 'not started',
    why: 'A6.7’s DNS-TXT verification and the 24 h purge on disputed ownership are not built; ownership is a confirmed checkbox, audited.',
    source: 'PROGRESS Phase 6 review list',
    plan: {
      screens: ['Website scan: “Verify with DNS” (token + status)'],
      endpoints: [
        'POST /api/studio/businesses/:id/domain-verification',
        'verification poll job + disputed-ownership purge job',
      ],
      days: 3,
      dependsOn: 'none',
    },
  },
  {
    id: 'scan-render-fallback',
    group: 'Business set-up',
    title: 'Browser-rendering fallback for blocked scans',
    blocker: 'not started',
    why: 'The playbook names a Playwright fallback for anti-bot sites; only Browserless (when a key is set), manual entry and stock images exist.',
    source: 'runbooks/scan-blocked.md GAP',
    plan: {
      screens: [],
      endpoints: ['headless render worker behind the same SSRF guard'],
      days: 3,
      dependsOn: 'a place to run headless Chromium',
    },
  },
  {
    id: 'voice-profiles',
    group: 'Business set-up',
    title: 'Voice profiles (brand voice cloning)',
    blocker: 'missing endpoint',
    why: 'Narration uses a brand kit’s voice profile when one exists, but nothing creates one: no endpoint or screen to clone a voice.',
    source: 'prisma VoiceProfile + generate-asset.ts vs src/app/api/studio',
    plan: {
      screens: ['Brand kits: “Voice” — record/upload samples, consent, preview'],
      endpoints: [
        'POST /api/studio/voice-profiles (ElevenLabs voice cloning)',
        'GET|DELETE /api/studio/voice-profiles/:id',
      ],
      days: 4,
      dependsOn: 'consent/audit policy for voice cloning',
    },
  },
];
