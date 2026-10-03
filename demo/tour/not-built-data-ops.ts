import type { NotBuiltItem } from './not-built-types';

// Admin, automation, pipeline, cost, infrastructure and GATE 12 items not built or not run.
// Sources: PROGRESS.md (GATE 12 list, Operator decisions "NOT BUILT" notes, phase review lists),
// BACKLOG.md unchecked items (9.2, 9.3, 12.2, 12.3, 12.5), runbooks/*.md GAP lines.
// Phase 17 closed the account-status, provider-outage alert, abandoned-upload, lost-publish and
// storage-backup GAPs, so they are not listed. Phase 18 Track D closed the Core-dependent Meta
// items for standalone mode: channel reconciliation does not apply (Studio owns the Meta login)
// and the Core Meta wiring is core-mode only; what is left is the operator's Meta app settings. Deployment target: one Hetzner VPS in Germany
// (Docker Compose; runbooks/vps-deploy.md, scripts/vps/deploy.sh).

export const PLATFORM_GAPS: NotBuiltItem[] = [
  // ------------------------------------------------------------------ Publishing and automation
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
    title: 'Storage lifecycle rules (S3 or R2)',
    blocker: 'needs people',
    why: 'Ready to run for S3 or R2 (infra/r2-lifecycle.json): `npx tsx scripts/ops/apply-s3-lifecycle.ts` picks infra/s3-lifecycle.json (STORAGE_PROVIDER=s3) or infra/r2-lifecycle.json (STORAGE_PROVIDER=r2, the production choice), prints the dry-run diff against each bucket, then `--apply`; waiting for DevOps to run it with production credentials.',
    source:
      'BACKLOG 14.2; infra/s3-lifecycle.json; infra/r2-lifecycle.json; runbooks/storage-cost.md; runbooks/r2-setup.md',
    plan: {
      screens: [],
      endpoints: [
        'DevOps on S3: run the dry run, review the diff, re-run with --apply (s3:Get/PutLifecycleConfiguration); grant the workers s3:PutObjectTagging',
        'DevOps on R2: the same commands with STORAGE_PROVIDER=r2 and an Admin Read & Write R2 token (runbooks/r2-setup.md)',
      ],
      days: 0.25,
      dependsOn: 'DevOps with production AWS or Cloudflare R2 credentials',
    },
  },
  {
    id: 'r2-buckets',
    group: 'Infrastructure',
    title: 'R2 buckets, CORS, app token, backup bucket and backup token',
    blocker: 'needs people',
    why: 'The code and runbook are ready; nobody has created the Cloudflare side yet: four EU-jurisdiction buckets, CORS for browser uploads and the app’s Object Read & Write token (runbooks/r2-setup.md steps 1–5), plus the backup bucket and the backup job’s own token (step 7) that the nightly storage backup (17.5) copies into.',
    source: 'PROGRESS [R2], [17.5]; runbooks/r2-setup.md; runbooks/backup-recovery.md',
    plan: {
      screens: [],
      endpoints: [
        'operator: create the buckets with the EU jurisdiction, apply CORS, create both tokens, put them in the server’s secrets, dry-run then --apply scripts/ops/backup-storage.ts once',
      ],
      days: 0.5,
      dependsOn: 'a Cloudflare account with R2 enabled',
    },
  },
  // ------------------------------------------------------------------ Staging and people (GATE 12)
  {
    id: 'rehearsals',
    group: 'Staging and people (GATE 12)',
    title: 'Kill-switch and rollback rehearsals',
    blocker: 'needs staging',
    why: 'Built and ready to run: `npx tsx scripts/ops/staging-gate.ts --rehearse all --from-tag <N> --to-tag <N+1>` (all five kill-switch levels timed against 60 s, rollback N+1 → N timed against 5 min; report in ops/results, or the Staging gate workflow); waiting for the operator to run it on staging under load. STAGING_DEPLOY_CMD is the VPS deploy script (scripts/vps/deploy.sh, being built on its own branch), which deploys the N and N+1 image tags.',
    source: 'BACKLOG 12.2, 12.3; plans/phase-14.md 14.6; runbooks/staging-gate.md',
    plan: {
      screens: [],
      endpoints: [
        'staging-gate.ts --rehearse kill-switch, then --rehearse rollback; record in runbooks/staging-gate.md',
      ],
      days: 0.5,
      dependsOn:
        'the server (see “Hetzner server”), a read-only staging DB role, the N and N+1 image tags',
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
    title: 'Database restore drill',
    blocker: 'needs staging',
    why: 'Built and ready to run: `staging-gate.ts --snapshot` before the restore, then `DATABASE_URL=<restored> npx tsx scripts/ops/staging-gate.ts --restore-check --incident-at <ISO> --restore-started-at <ISO>` (migrate status, row counts vs snapshot, pgvector, read-only smoke, RTO/RPO); waiting for DevOps to restore the server’s nightly database backup from the R2 backup bucket into a scratch database and run the check.',
    source: 'PROGRESS GATE 12 list; plans/phase-14.md 14.7; runbooks/backup-recovery.md',
    plan: {
      screens: [],
      endpoints: [
        'DevOps: snapshot → restore the nightly backup (runbooks/vps-deploy.md) → --restore-check → golden-path smoke',
      ],
      days: 0.5,
      dependsOn: 'the server’s nightly database backup in the R2 backup bucket',
    },
  },
  {
    id: 'live-providers',
    group: 'Staging and people (GATE 12)',
    title: 'Live provider and posting runs',
    blocker: 'needs staging',
    why: 'Built and ready to run: `npm run gate:live` (prints the cost estimate from the adapters’ estimators), then `npm run gate:live -- --confirm` (every GATE 2 script, adapter tests for Music, AssemblyAI, OpenAI, Storyblocks, a voice clone, and one post + takedown per platform); waiting for the operator with staging keys and platform test accounts (TikTok posts are removed by hand).',
    source: 'PROGRESS GATE 2, 3, 5, 8; plans/phase-14.md 14.8; runbooks/staging-gate.md',
    plan: {
      screens: [],
      endpoints: ['gate:live --confirm; gate3 follow-up by hand'],
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
    id: 'meta-connect-app',
    group: 'Staging and people (GATE 12)',
    title: 'Meta connect: Studio’s own Meta app settings',
    blocker: 'needs operator app settings',
    why: 'Built (Phase 18 Track D): Studio runs Facebook Login for Business itself — Connect on /connections, long-lived Page tokens sealed with KMS, appsecret_proof on every Graph call, signed deauthorise and data-deletion callbacks with a status page. Connect stays hidden (“Studio’s Meta app still needs its settings”) until the operator configures Studio’s Meta app and App Review grants Advanced Access.',
    source: 'runbooks/meta-connect.md; plans/phase-18.md §2.10, §7 “Operator must provide” item 4',
    plan: {
      screens: [],
      endpoints: [
        'Operator: Business-type Meta app + Business Verification; FLfB configuration (User access token; Pages + Instagram assets; pages_show_list, pages_read_engagement, pages_manage_posts, read_insights, instagram_basic, instagram_content_publish, instagram_manage_insights) → META_LOGIN_CONFIG_ID',
        'Operator: redirect URI https://<host>/api/studio/platform-connections/oauth-callback, deauthorise https://<host>/api/meta/deauthorize, data deletion https://<host>/api/meta/data-deletion, Require App Secret on; META_APP_ID / META_APP_SECRET in the VPS env',
        'Staging: connect a Page and its Instagram account, publish a Reel, disconnect, and fire the deauthorise callback',
      ],
      days: 1,
      dependsOn: 'Meta App Review (Advanced Access for the permissions above)',
    },
  },
  {
    id: 'alerting-deploy',
    group: 'Staging and people (GATE 12)',
    title: 'Alert routing: PagerDuty key and Slack webhook',
    blocker: 'needs people',
    why: 'Prometheus and Alertmanager run in the server’s Compose stack (docker-compose.monitoring.yml, rules incl. the 17.4 failover alert); alerts reach nobody until DevOps supplies the PagerDuty routing key and the Slack webhook and runs `ALERTMANAGER_URL=http://127.0.0.1:9093 npx tsx scripts/ops/alert-smoke.ts` (runbooks/monitoring-deploy.md).',
    source: 'BACKLOG 14.3, 17.4; docker-compose.monitoring.yml; runbooks/monitoring-deploy.md',
    plan: {
      screens: [],
      endpoints: [
        'DevOps: PagerDuty Events API v2 key + #studio-alerts webhook as secret files on the server, restart Alertmanager, record a passing smoke test',
      ],
      days: 0.5,
      dependsOn: 'DevOps; PagerDuty service; #studio-alerts channel',
    },
  },
  {
    id: 'vps-server',
    group: 'Staging and people (GATE 12)',
    title: 'Hetzner server, setup script and secrets',
    blocker: 'needs people',
    why: 'Studio runs on one Hetzner VPS in Germany: Caddy (TLS) → web, one worker process for all six queues, Postgres 17 + pgvector, Redis, Prometheus/Alertmanager and the nightly backups, all in Docker Compose; files in Cloudflare R2 (EU), keys in AWS KMS. Waiting for the operator to rent the server, run the setup script and fill in the secrets (runbooks/vps-deploy.md).',
    source: 'runbooks/vps-deploy.md; scripts/vps/deploy.sh (being built on its own branch)',
    plan: {
      screens: [],
      endpoints: [
        'operator: rent the server, point DNS at it, run the setup script, fill in the secrets (JWT, KMS, R2, provider and platform keys), then scripts/vps/deploy.sh and the first-deploy checks',
      ],
      days: 1,
      dependsOn: 'a Hetzner account, the domain’s DNS, the provider and platform keys',
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
