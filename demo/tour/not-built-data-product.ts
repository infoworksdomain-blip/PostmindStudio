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
    why: 'Built and ready to run: `docker compose -p postmind-studio -f docker-compose.prod.yml --profile headless-render up -d browserless` with STUDIO_HEADLESS_RENDER_URL=http://browserless:3000 and the token file (runbooks/scan-blocked.md); used only for sites whose owner confirmed ownership, never against a third party’s bot protection; waiting for the operator to enable the profile on staging.',
    source: 'BACKLOG 14.4; docker-compose.prod.yml; runbooks/scan-blocked.md',
    plan: {
      screens: [],
      endpoints: [
        'operator: create the token file, set the two env vars, enable the profile on staging, check one owned 403 site, then production',
      ],
      days: 0.25,
      dependsOn: 'operator on staging',
    },
  },
];
