import type { NotBuiltItem } from './not-built-types';

// Admin, automation, pipeline, cost, infrastructure and GATE 12 items not built or not run.
// Sources: PROGRESS.md (GATE 12 list, Operator decisions "NOT BUILT" notes, phase review lists),
// BACKLOG.md unchecked items (9.2, 9.3, 12.2, 12.3, 12.5), runbooks/*.md GAP lines.

export const PLATFORM_GAPS: NotBuiltItem[] = [
  // ------------------------------------------------------------------ Publishing and automation
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
    why: 'Luma (AI_CLIP fallback for Runway) and HeyGen (AI_AVATAR) are built (13.32), so an open Runway breaker now fails over to Luma. Storyblocks video and Pexels video (STOCK_FOOTAGE), Storyblocks music (music fallback) and the OpenAI text and transcription fallbacks are built (Phase 15 Track C). Kling, Veo, fal, Replicate, D-ID, Azure Speech, Creatomate and Sightengine are still router candidates without adapters: BASIC-tier clips, the voice/composition/safety fallbacks and a second avatar provider have no fallback yet.',
    source:
      'PROGRESS GATE 2 review list; providers/router.ts; plans/phase-13.md 13.38 (docs + router slot per provider)',
    plan: {
      screens: [],
      endpoints: ['one adapter per provider implementing ProviderAdapter + cost estimate'],
      days: 12,
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
    why: 'Built and ready to run: `npx tsx scripts/ops/apply-s3-lifecycle.ts` (dry-run diff of infra/s3-lifecycle.json against each bucket, then `--apply`) with AWS_REGION and the S3_BUCKET_* names; waiting for DevOps to run it with production credentials.',
    source: 'BACKLOG 14.2; infra/s3-lifecycle.json; runbooks/storage-cost.md',
    plan: {
      screens: [],
      endpoints: [
        'DevOps: run the dry run, review the diff, re-run with --apply (s3:Get/PutLifecycleConfiguration); grant the workers s3:PutObjectTagging',
      ],
      days: 0.25,
      dependsOn: 'DevOps with production AWS credentials',
    },
  },
  // ------------------------------------------------------------------ Staging and people (GATE 12)
  {
    id: 'rehearsals',
    group: 'Staging and people (GATE 12)',
    title: 'Kill-switch and rollback rehearsals',
    blocker: 'needs staging',
    why: 'Built and ready to run: `npx tsx scripts/ops/staging-gate.ts --rehearse all --from-tag <N> --to-tag <N+1>` (all five kill-switch levels timed against 60 s, rollback N+1 → N timed against 5 min; report in ops/results, or the Staging gate workflow); waiting for the operator to run it on staging under load, with DevOps providing STAGING_DEPLOY_CMD.',
    source: 'BACKLOG 12.2, 12.3; plans/phase-14.md 14.6; runbooks/staging-gate.md',
    plan: {
      screens: [],
      endpoints: [
        'staging-gate.ts --rehearse kill-switch, then --rehearse rollback; record in runbooks/staging-gate.md',
      ],
      days: 0.5,
      dependsOn: 'staging under load, a read-only staging DB role, the N and N+1 image tags',
    },
  },
  {
    id: 'k6',
    group: 'Staging and people (GATE 12)',
    title: 'k6 smoke + full run and queue-throughput target',
    blocker: 'needs staging',
    why: 'Built and ready to run: `npx tsx scripts/ops/staging-gate.ts --k6 smoke` then `--k6 full` (re-checks the spec 17.1 thresholds from the k6 summary export, measures queue throughput against spec 17.2, writes ops/results; also the Staging gate workflow); waiting for the operator to run it on staging and tune the alert thresholds from the results.',
    source: 'PROGRESS GATE 12 list; plans/phase-14.md 14.5; runbooks/staging-gate.md',
    plan: {
      screens: [],
      endpoints: [
        'staging-gate.ts --k6 smoke|full; tune StudioQueueBacklog / failure-rate thresholds',
      ],
      days: 0.5,
      dependsOn: 'staging + a load-test organisation JWT',
    },
  },
  {
    id: 'pitr',
    group: 'Staging and people (GATE 12)',
    title: 'Point-in-time restore drill',
    blocker: 'needs staging',
    why: 'Built and ready to run: `staging-gate.ts --snapshot` before the restore, then `DATABASE_URL=<restored> npx tsx scripts/ops/staging-gate.ts --restore-check --incident-at <ISO> --restore-started-at <ISO>` (migrate status, row counts vs snapshot, pgvector, read-only smoke, RTO/RPO); waiting for DevOps to perform the PITR restore and run the check.',
    source: 'PROGRESS GATE 12 list; plans/phase-14.md 14.7; runbooks/backup-recovery.md',
    plan: {
      screens: [],
      endpoints: ['DevOps: snapshot → PITR restore → --restore-check → golden-path smoke'],
      days: 0.5,
      dependsOn: 'staging database with PITR enabled',
    },
  },
  {
    id: 'live-providers',
    group: 'Staging and people (GATE 12)',
    title: 'Live provider and posting runs',
    blocker: 'needs staging',
    why: 'Built and ready to run: `npm run gate:live` (prints the cost estimate from the adapters’ estimators), then `npm run gate:live -- --confirm` (every GATE 2 script, adapter tests for Music, Hive, AssemblyAI, OpenAI, Storyblocks, a voice clone, and one post + takedown per platform); waiting for the operator with staging keys and platform test accounts (TikTok posts are removed by hand).',
    source: 'PROGRESS GATE 2, 3, 5, 8; plans/phase-14.md 14.8; runbooks/staging-gate.md',
    plan: {
      screens: [],
      endpoints: ['gate:live --confirm; Hive async + gate3 follow-ups by hand'],
      days: 1,
      dependsOn: 'staging keys, platform test accounts, hosted fonts (STUDIO_FONTS_BASE_URL)',
    },
  },
  {
    id: 'corpus-runs',
    group: 'Staging and people (GATE 12)',
    title: 'Corpus sample run (9.2) and full run (9.3)',
    blocker: 'needs people',
    why: 'Built and ready to run: `npx tsx scripts/ops/ingest-corpus.ts corpus.csv --preflight --sample 100` (caps tier, worker slots, bucket access, manifest; template in corpus/manifest.template.csv), then the sample, the review checklist in runbooks/corpus-ingestion.md, and the full run; waiting for the operator to supply the manifest, review the sample and start the full run.',
    source: 'BACKLOG 9.2, 9.3; plans/phase-14.md 14.9; runbooks/corpus-ingestion.md',
    plan: {
      screens: [],
      endpoints: ['--preflight → --sample 100 --apply → review → --preflight (full) → --apply'],
      days: 2,
      dependsOn: 'the corpus manifest; STUDIO_LIBRARY_PLAN_TIER=ENTERPRISE on the library workers',
    },
  },
  {
    id: 'core-meta-wiring',
    group: 'Staging and people (GATE 12)',
    title: 'Core wiring for the Meta internal endpoints',
    blocker: 'needs people',
    why: 'Built and ready: integration kit in integrations/core (OpenAPI spec, copyable client with retries, retry/alerting recipe, contract suite: npm run contract:core -- --base-url <staging> --token <token>); waiting for the Core team to wire it in and run the suite against staging.',
    source: 'BACKLOG 14.10; integrations/core/README.md; runbooks/platform-account-revocation.md',
    plan: {
      screens: [],
      endpoints: [
        'Core: call registerChannel / disconnect / pushRefreshedTokens / purgeOrganisation with the copied client, durable retries + alerts, publish + insights scopes',
      ],
      days: 2,
      dependsOn: 'Core team',
    },
  },
  {
    id: 'alerting-deploy',
    group: 'Staging and people (GATE 12)',
    title: 'Prometheus + Alertmanager deployment',
    blocker: 'needs people',
    why: 'Built and ready to run: `docker compose -f docker-compose.monitoring.yml up -d` then `ALERTMANAGER_URL=http://127.0.0.1:9093 npx tsx scripts/ops/alert-smoke.ts` (runbooks/monitoring-deploy.md); waiting for DevOps to supply the PagerDuty routing key and Slack webhook and run it.',
    source: 'BACKLOG 14.3; docker-compose.monitoring.yml; runbooks/monitoring-deploy.md',
    plan: {
      screens: [],
      endpoints: [
        'DevOps: PagerDuty Events API v2 key + #studio-alerts webhook as secret files, start the stack on staging then production, record a passing smoke test',
      ],
      days: 0.5,
      dependsOn: 'DevOps; PagerDuty service; #studio-alerts channel',
    },
  },
  {
    id: 'beta',
    group: 'Staging and people (GATE 12)',
    title: 'Beta onboarding, on-call rota, Trust & Safety audit',
    blocker: 'needs people',
    why: 'Built; waiting for people: recruit 5–10 beta customers (enrol them in Admin → Beta: Plus for 30 days, feedback, usage), staff the rota (ops/oncall/rota.template.yaml → PagerDuty, runbooks/on-call.md) and run the monthly audits (Admin → Safety audit).',
    source: 'BACKLOG 14.11; runbooks/on-call.md; runbooks/content-safety-miss.md',
    plan: {
      screens: [],
      endpoints: [
        'people: recruit and onboard the cohort, fill the rota and configure PagerDuty, review each month’s sample',
      ],
      days: 8,
      dependsOn: 'GA candidate on staging',
    },
  },
];
