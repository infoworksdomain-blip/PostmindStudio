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
    why: 'Contract shipped, waiting for an operator decision: Core sends email (no Core email API yet) or Studio sends it via Resend/SES. EmailSender + STUDIO_EMAIL_PROVIDER exist; opted-in email is recorded as “pending setup” and the bell says so.',
    source: 'PROGRESS [13.33]; runbooks/notifications-email.md GAP',
    plan: {
      // 13.24 built the preferences (table, GET|PATCH, dialog); email delivery is what waits.
      screens: ['Slack opt-in next to the email switch (preferences dialog exists)'],
      endpoints: [
        'CoreEmailSender.send against the Core email API, or a Resend/SES adapter (EmailSender contract shipped)',
      ],
      days: 4,
      dependsOn:
        'operator decision: a Core email API, or Studio sends email itself (runbooks/notifications-email.md)',
    },
  },
  // ------------------------------------------------------------------ Create and review
  // ------------------------------------------------------------------ Library and images
  {
    id: 'bpm-clip-clap',
    group: 'Library and images',
    title: 'BPM / key detection, CLIP visual and CLAP audio embeddings',
    blocker: 'blocked on a dependency',
    why: 'Contract shipped, waiting for an inference host decision: the media_analysis capability and media-analysis adapter exist but report unhealthy (“no inference host configured”) and are never routed. bpm and key are null and similarity is one text-embedding distance.',
    source: 'PROGRESS [13.36]; providers/media-analysis.ts',
    plan: {
      screens: ['Library detail: BPM, key; “Similar look / similar sound” shelves'],
      endpoints: [
        'transport for the media-analysis adapter to the chosen host (librosa + open_clip + CLAP)',
        'migration: video_library_embeddings visualEmbedding / audioEmbedding vector(512) + model columns',
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
    why: 'Built (13.29): a nightly job learns shot pace, visual mix, generator preference, script structure and posting time from approvals, rejections, regenerations and YouTube retention; the Business “What Studio has learned” tab shows each with its reason and a delete; Layers 1–2 get the strong signals as fenced data. Not yet: comment sentiment as a signal (Engagement classifier, 13.39) and style memory adjusting the provider router’s scores (spec 10.3).',
    source: 'PROGRESS [13.29]; services/style-memory.ts',
    plan: {
      screens: [],
      endpoints: [
        'sentiment signal from EngagementSentimentClient once Engagement ships it',
        'router: boost providers from PROVIDER_PREFERENCE (spec 10.3 providerScores.adjust)',
      ],
      days: 2,
      dependsOn:
        'Engagement sentiment API (client contract shipped, 13.39: EngagementSentimentClient); more platforms reporting retention',
    },
  },
  // ------------------------------------------------------------------ Manage
  {
    id: 'business-list',
    group: 'Manage',
    title: 'Business list and picker',
    blocker: 'blocked on a dependency',
    why: 'Contract shipped, waiting for Core list-businesses: GET /api/studio/businesses answers 501 and the header switcher (a picker as soon as it answers) stays a typed business id; Studio cannot yet verify a business belongs to the organisation.',
    source: 'PROGRESS [13.34]; core/business-directory.ts',
    plan: {
      screens: ['Header business switcher as a searchable list'],
      endpoints: [
        'Core: GET /api/internal/organisations/:id/businesses',
        'Studio: CoreBusinessDirectory over that endpoint (cached) + validation on writes',
      ],
      days: 1,
      dependsOn: 'Core team adds the endpoint',
    },
  },
  {
    id: 'analytics-depth',
    group: 'Manage',
    title: 'Deeper analytics (retention, demographics, LinkedIn, TikTok watch time)',
    blocker: 'blocked on a dependency',
    why: 'YouTube retention curves and audience demographics are built (13.28: per-publication analytics page from the leaderboard). LinkedIn post analytics needs the vetted Community Management API; TikTok watch time only exists in the TikTok API for Business; Meta retention/demographics are not read.',
    source: 'PROGRESS [13.28]; analytics/fetchers.ts',
    plan: {
      screens: [],
      endpoints: [
        'LinkedIn reader enabled via LINKEDIN_POST_ANALYTICS',
        'TikTok for Business watch time',
      ],
      days: 2,
      dependsOn: 'LinkedIn product approval; TikTok for Business app',
    },
  },
  // ------------------------------------------------------------------ Business set-up
  {
    id: 'scan-render-fallback',
    group: 'Business set-up',
    title: 'Browser-rendering fallback for blocked scans',
    blocker: 'needs staging',
    why: 'Contract shipped, waiting for a headless Chromium host: with STUDIO_HEADLESS_RENDER_URL set, a homepage refused with 403/429/503 is rendered once (self-hosted Browserless /content); unset, scans fall back to manual entry as before.',
    source: 'PROGRESS [13.37]; runbooks/scan-blocked.md GAP',
    plan: {
      screens: [],
      endpoints: [
        'deploy ghcr.io/browserless/chromium privately and set STUDIO_HEADLESS_RENDER_URL/_TOKEN',
      ],
      days: 0.5,
      dependsOn:
        'operator decision to run it (scan-blocked.md policy) and a place to run headless Chromium',
    },
  },
];
