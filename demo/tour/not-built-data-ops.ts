import type { NotBuiltItem } from './not-built-types';

// Admin, automation, pipeline, cost, infrastructure and GATE 12 items not built or not run.
// Sources: PROGRESS.md (GATE 12 list, Operator decisions "NOT BUILT" notes, phase review lists),
// BACKLOG.md unchecked items (9.2, 9.3, 12.2, 12.3, 12.5), runbooks/*.md GAP lines.

export const PLATFORM_GAPS: NotBuiltItem[] = [
  // ------------------------------------------------------------------ Publishing and automation
  {
    id: 'meta-purge',
    group: 'Publishing and automation',
    title: 'Organisation purge: hard deletion after the 30-day grace',
    blocker: 'not started',
    why: 'POST /internal/organisations/:id/purge (13.22) wipes tokens, disconnects channels, engages the workspace kill switch and soft-deletes with graceUntil = +30 days; nothing yet hard-deletes the rows and S3 objects once the grace period ends.',
    source: 'PROGRESS [13.22]; runbooks/platform-account-revocation.md',
    plan: {
      screens: [],
      endpoints: [
        'operator-run, audited sweep over studio.organisation_purges past graceUntil (rows + S3 objects), dry run first',
      ],
      days: 2,
      dependsOn: 'Core calls the purge on organisation deletion; data-retention sign-off',
    },
  },
  {
    id: 'meta-reconcile',
    group: 'Publishing and automation',
    title: 'Core ↔ Studio channel reconciliation and account-status check',
    blocker: 'blocked on a dependency',
    why: 'Reconciliation contract shipped, waiting for Core list-channels: the daily reconcile-channels job skips and GET /admin/channels/reconciliation answers 501, so a missed DELETE still leaves a channel active until Meta refuses its token. The daily account-status check is not built.',
    source: 'PROGRESS [13.35]; runbooks/platform-account-revocation.md GAPs',
    plan: {
      screens: ['Connections: “last checked” per account'],
      endpoints: [
        'CoreChannelDirectory over Core list-channels (reconcile job + logic already built)',
        'daily account-status job per platform',
      ],
      days: 2,
      dependsOn: 'Core: list-channels endpoint',
    },
  },
  // ------------------------------------------------------------------ Pipeline and media
  {
    id: 'fallback-adapters',
    group: 'Pipeline and media',
    title: 'Fallback provider adapters',
    blocker: 'blocked on a dependency',
    why: 'Luma (AI_CLIP fallback for Runway) and HeyGen (AI_AVATAR) are built (13.32), so an open Runway breaker now fails over to Luma. Kling, Veo, fal, Replicate, D-ID, Storyblocks, Pexels footage, Azure Speech, Creatomate and Sightengine are still router candidates without adapters: BASIC-tier clips, stock footage, the voice/composition/safety fallbacks and a second avatar provider have no fallback yet.',
    source:
      'PROGRESS GATE 2 review list; providers/router.ts; plans/phase-13.md 13.38 (docs + router slot per provider)',
    plan: {
      screens: [],
      endpoints: ['one adapter per provider implementing ProviderAdapter + cost estimate'],
      days: 15,
      dependsOn: 'provider accounts and keys (≈ 1.5 days each)',
    },
  },
  // ------------------------------------------------------------------ Cost controls
  // ------------------------------------------------------------------ Infrastructure
  {
    id: 's3-lifecycle',
    group: 'Infrastructure',
    title: 'S3 lifecycle rules',
    blocker: 'needs people',
    why: 'Lifecycle and version-expiry rules live in the infrastructure repo and are not verified by code here.',
    source: 'runbooks/storage-cost.md GAP; GATE 12 list',
    plan: {
      screens: [],
      endpoints: ['lifecycle policy in infrastructure-as-code, linked from the runbook'],
      days: 1,
      dependsOn: 'DevOps',
    },
  },
  // ------------------------------------------------------------------ Staging and people (GATE 12)
  {
    id: 'rehearsals',
    group: 'Staging and people (GATE 12)',
    title: 'Kill-switch and rollback rehearsals',
    blocker: 'needs staging',
    why: 'Tooling and procedures are built (rehearse-kill-switch.ts, runbooks/rollback.md); the timed runs against the 60 s and 5 min SLOs have not happened.',
    source: 'BACKLOG 12.2, 12.3',
    plan: {
      screens: [],
      endpoints: ['run on staging; record timings in PROGRESS.md'],
      days: 1,
      dependsOn: 'staging environment with workers under load',
    },
  },
  {
    id: 'k6',
    group: 'Staging and people (GATE 12)',
    title: 'k6 smoke + full run and queue-throughput target',
    blocker: 'needs staging',
    why: 'load-test/k6/studio-api.js is ready; it has never been run, and alert thresholds wait on its results.',
    source: 'PROGRESS GATE 12 list; runbooks/README.md GAP',
    plan: {
      screens: [],
      endpoints: ['run smoke then full; tune StudioQueueBacklog / failure-rate thresholds'],
      days: 1,
      dependsOn: 'staging + a load-test organisation JWT',
    },
  },
  {
    id: 'pitr',
    group: 'Staging and people (GATE 12)',
    title: 'Point-in-time restore drill',
    blocker: 'needs staging',
    why: 'The backup/recovery runbook exists; no PITR restore has been rehearsed.',
    source: 'PROGRESS GATE 12 list',
    plan: {
      screens: [],
      endpoints: ['restore drill per runbooks/backup-recovery.md; record RTO/RPO'],
      days: 1,
      dependsOn: 'staging database with PITR enabled',
    },
  },
  {
    id: 'live-providers',
    group: 'Staging and people (GATE 12)',
    title: 'Live provider and posting runs',
    blocker: 'needs staging',
    why: 'Every provider and publisher is tested against documented contracts and fakes; live runs (npm run gate2:* / gate3, a real post per platform, first live Shotstack font check) are the operator’s.',
    source: 'PROGRESS GATE 2, 3, 5, 8',
    plan: {
      screens: [],
      endpoints: ['run with staging keys and one test account per platform'],
      days: 2,
      dependsOn: 'staging keys, platform test accounts, hosted fonts (STUDIO_FONTS_BASE_URL)',
    },
  },
  {
    id: 'corpus-runs',
    group: 'Staging and people (GATE 12)',
    title: 'Corpus sample run (9.2) and full run (9.3)',
    blocker: 'needs people',
    why: 'Unblocked (no licence needed), tooling ready; the 100-video sample needs operator review before the 50k run, which needs ENTERPRISE caps and more library workers.',
    source: 'BACKLOG 9.2, 9.3; runbooks/corpus-ingestion.md',
    plan: {
      screens: [],
      endpoints: ['scripts/ops/ingest-corpus.ts --sample 100 --apply, review, then --apply'],
      days: 3,
      dependsOn: 'the corpus manifest; STUDIO_LIBRARY_PLAN_TIER=ENTERPRISE',
    },
  },
  {
    id: 'core-meta-wiring',
    group: 'Staging and people (GATE 12)',
    title: 'Core wiring for the Meta internal endpoints',
    blocker: 'needs people',
    why: 'Studio’s endpoints are ready; Core must call them as it calls Engagement’s, request publish + insights scopes, and add retry/alerting for failed calls.',
    source: 'PROGRESS [OPS-meta] NOTE; runbooks/platform-account-revocation.md',
    plan: {
      screens: [],
      endpoints: ['Core: POST /internal/channels, DELETE, POST /internal/tokens/refreshed'],
      days: 3,
      dependsOn: 'Core team',
    },
  },
  {
    id: 'alerting-deploy',
    group: 'Staging and people (GATE 12)',
    title: 'Prometheus + Alertmanager deployment',
    blocker: 'needs people',
    why: 'Rules and routing are committed and CI-tested but not deployed; nothing has paged a human yet.',
    source: 'runbooks/README.md GAP; GATE 12 list',
    plan: {
      screens: [],
      endpoints: [
        'scrape jobs, rule file, Alertmanager with the PagerDuty key and Slack webhook files',
      ],
      days: 2,
      dependsOn: 'DevOps; PagerDuty service; #studio-alerts channel',
    },
  },
  {
    id: 'beta',
    group: 'Staging and people (GATE 12)',
    title: 'Beta onboarding, on-call rota, Trust & Safety audit',
    blocker: 'needs people',
    why: '5–10 friendly customers, an on-call rota and the monthly content-safety audit process are people work before the Go / No-Go.',
    source: 'BACKLOG 12.5; PROGRESS GATE 12 list; runbooks/content-safety-miss.md GAP',
    plan: {
      screens: [],
      endpoints: ['onboarding sessions, feedback log, rota, audit sampling'],
      days: 10,
      dependsOn: 'GA candidate on staging',
    },
  },
];
