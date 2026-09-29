import { ALERTMANAGER, ALERT_RULES, ALERT_RULE_NAMES, K6_OPTIONS, K6_RUN } from './system-snippets';
import { Chapter, Code, DataTable, Panel, Pill } from './ui';

// Behind the scenes, part 4: alerting, corpus ingestion, load test, deployment (one Hetzner VPS
// running the Docker Compose stack; runbooks/vps-deploy.md), runbooks and golden-path journeys. Output formats follow library/corpus-report.ts and
// scripts/ops/ingest-corpus.ts; names come from runbooks/*.md and test/golden/*.test.ts.

// A sample --sample 100 --apply run (numbers illustrative; the real run is the operator's).
const CORPUS_RUN = `$ STUDIO_URL=https://studio.postmind.ai STUDIO_STAFF_TOKEN=… \\
  npx tsx scripts/ops/ingest-corpus.ts corpus.csv --sample 100 --seed 7 --apply
Manifest corpus.csv: 50000 rows, 49997 valid.
3 invalid row(s) — fix them in the manifest:
  line 812: unknown category slug "food/bakery"
  line 20441: duplicate of line 1937 (https://cdn.example/corpus/v/20441.mp4)
  line 38002: has 7 fields, header has 6
State corpus.csv.state.json: 0 accepted, 0 already ingested, 0 rejected earlier.
Sample of 100 to submit, by category:
  business                 31
  lifestyle                19
  product-marketing        14
  education                12
  entertainment            9
  personal-brand           7
  community                5
  news-and-commentary      3
Estimate for 100 videos:
  cost  £2.00–£5.00 in provider calls (£0.02–£0.05 each)
  time  ~2.5 h at 2 concurrent job slot(s), assuming 3 min per video
        (queue concurrency × worker processes; replace the assumption with the sample run’s
        measured completedPerHour from GET /admin/library/ingest/status)
  submitted 100/100
Submitted 100/100. State: 100 accepted, 0 already ingested, 0 rejected (re-run to retry).
Waiting up to 180 min for 100 ingest runs…
  41/100 finished
  100/100 finished`;

const CORPUS_REPORT = `SAMPLE REVIEW — 100 submitted
  ingested ok: 97   failed: 3   still running: 0
Category distribution (ingested):
  business                 30
  lifestyle                19
  product-marketing        14
  education                12
  entertainment            8
  personal-brand           7
  community                4
  news-and-commentary      3
Failures:
  line 4410: Source video is larger than 200 MB (https://cdn.example/corpus/v/4410.mp4)
  line 17215: Source returned HTTP 404 (https://cdn.example/corpus/v/17215.mp4)
  line 30877: Source has no video duration (https://cdn.example/corpus/v/30877.mp4)
Review these items (random 10):
  https://studio.postmind.ai/library/lib-pov-morning-bake  POV: 5am at a neighbourhood bakery [pm-00412]
  https://studio.postmind.ai/library/lib-three-step-recipe  Three-step focaccia, no mixer [pm-03388]
  …
Approve the sample (runbooks/corpus-ingestion.md step 3), then run the full ingestion with
the same --state file and --apply (without --sample): accepted rows are skipped.`;

const RUNBOOKS: [string, string][] = [
  ['kill-switch.md', 'Kill switch (spec §12, playbook §11.4)'],
  ['rollback.md', 'Rollback — SLO 5 minutes'],
  ['deploy.md', 'Deploy'],
  ['backup-recovery.md', 'Backup and recovery'],
  ['service-health.md', 'Service health alerts'],
  ['provider-outage.md', 'Provider outage during a generation window (risk 1)'],
  ['cost-runaway.md', 'Cost runaway, per organisation (risk 2)'],
  ['content-safety-miss.md', 'Content-safety false negative published (risk 3)'],
  ['platform-api-change.md', 'Publishing platform API breaking change (risk 4)'],
  ['corpus-search-quality.md', 'Corpus search quality degradation (risk 5)'],
  ['scan-blocked.md', 'Website scan blocked by anti-bot measures (risk 6)'],
  [
    'platform-account-revocation.md',
    'Platform account revocation — Meta, TikTok, YouTube (risk 7)',
  ],
  ['storage-cost.md', 'Storage cost balloon (risk 8)'],
  ['r2-setup.md', 'Cloudflare R2 setup (buckets, CORS, tokens, backup bucket)'],
  ['storage-failover.md', 'Storage failover to the secondary region'],
  ['monitoring-deploy.md', 'Prometheus + Alertmanager deployment'],
  ['staging-gate.md', 'Staging gate (rehearsals, k6, restore drill, live providers)'],
  ['vps-deploy.md', 'Deploying on the Hetzner server (on its own branch)'],
  ['corpus-ingestion.md', 'Corpus ingestion (9.2 sample run, 9.3 full run)'],
  ['review-publish-automation.md', 'Review and publish automation'],
];

const JOURNEYS: [string, string[]][] = [
  [
    'golden-path.test.ts',
    [
      'GP-01 brief → generate → review → approve → publish now',
      'GP-02 scheduled publication fires; a cancelled one never publishes',
      'GP-03 one brief renders TikTok, Shorts and Reels',
      'GP-04 quality failure → force-approve → publish',
      'GP-05 reject → regenerate one shot → approve',
      'GP-06 slideshow from a template → auto-populate',
      'GP-07 library reference: TEMPLATE and INSPIRE',
      'GP-08 overlays + watermark → re-render → publish',
      'GP-09 website scan → profile → image library',
      'GP-10 default brand kit shapes the video',
      'GP-11 publication fails → retry → published',
      'GP-12 take down (TikTok refuses cleanly)',
      'GP-13 workspace freeze isolates one org',
      'GP-14 analytics polled and served',
      'GP-15 budget cap stops spend before the video provider',
    ],
  ],
  [
    'automation.test.ts',
    [
      'GA-01 untrusted creator stays in review',
      'GA-02 trusted creator auto-approved and auto-published',
      'GA-03 forced/flagged runs never auto-approved',
      'GA-04 human approval publishes stored targets',
      'GA-05 template save → create → inherit',
    ],
  ],
  [
    'cost-caps.test.ts',
    [
      'CC-01 project pauses at 90%, resumes after raise',
      'CC-02 org daily cap pauses generation, publish still goes',
      'CC-03 80% alert fires exactly once',
    ],
  ],
  [
    'monthly-cap.test.ts',
    [
      'MC-01 default short/long-form budgets',
      'MC-02 monthly 80% alert once',
      'MC-03 100% monthly pauses generation only',
    ],
  ],
  [
    'music.test.ts',
    [
      'GM-01 music under narration, reused on re-render',
      'GM-02 slideshow music with template mood',
      'GM-03 BASIC is narration only',
      'GM-04 music refused → video still ready',
    ],
  ],
  [
    'recovery.test.ts',
    [
      'GR-01 platform kill → release → re-drive once',
      'GR-02 freeze mid-pipeline → resume without re-paying',
      'GR-03 stuck after Redis loss → re-enqueued',
      'GR-04 non-staff cannot re-drive',
    ],
  ],
  [
    'meta.test.ts',
    [
      'META-01 Core registers Instagram → Reel published → metrics',
      'META-02 token rejected → needs_reconnect → refresh',
    ],
  ],
  ['corpus.test.ts', ['CO-01 manifest → sample → review → TEMPLATE project → resumed full run']],
];

const ON_SERVER: [string, string, string][] = [
  ['caddy', ':443', 'TLS (automatic certificates) → web'],
  ['web', ':3010', 'next start · API + UI · /api/health, /api/health/ready'],
  [
    'worker',
    '1 process',
    'all six queues: orchestration, assets, publish, scheduled, analytics, library',
  ],
  ['postgres', '17', 'pgvector · studio schema'],
  ['redis', 'DB 3', 'BullMQ, rate limits, idempotency'],
  ['prometheus + alertmanager', 'monitoring', 'scrapes /api/metrics and the worker’s :9464'],
  ['backups', 'nightly', 'database + object storage → the R2 backup bucket'],
];

const OFF_SERVER: [string, string][] = [
  ['Cloudflare R2 (EU jurisdiction)', 'assets, renders, thumbnails, library + the backup bucket'],
  ['AWS KMS', 'envelope keys for tokens and secrets (KMS_KEY_ID)'],
  ['PostMind Core', 'JWKS for sign-in, business and channel data'],
  ['AI providers and platforms', 'Runway, Luma, ElevenLabs … TikTok, YouTube, Meta, LinkedIn, X'],
];

function Topology() {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_17rem]">
      <div className="rounded-xl border-2 border-foreground/80 bg-card p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-semibold">One Hetzner server · Germany</p>
          <Pill tone="data">Docker Compose</Pill>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          One image (web + worker roles; non-root, ffmpeg, tini), tagged with the git SHA and
          deployed by scripts/vps/deploy.sh. Cost: one server, priced on Hetzner’s site.
        </p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {ON_SERVER.map(([name, n, what]) => (
            <li
              key={name}
              className="flex items-start justify-between gap-3 rounded-lg border border-border/80 bg-background px-3 py-2"
            >
              <div className="min-w-0">
                <p className="font-mono text-xs font-medium">{name}</p>
                <p className="text-[0.7rem] text-muted-foreground">{what}</p>
              </div>
              <Pill tone={name === 'caddy' || name === 'web' ? 'live' : 'data'}>{n}</Pill>
            </li>
          ))}
        </ul>
      </div>
      <div className="grid content-start gap-2 text-sm">
        <p className="text-xs text-muted-foreground">Outside the server</p>
        <ul className="grid gap-2">
          {OFF_SERVER.map(([k, v]) => (
            <li key={k} className="rounded-lg bg-muted px-3 py-2">
              <p className="font-medium">{k}</p>
              <p className="text-xs text-muted-foreground">{v}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function DeliveryChapters() {
  return (
    <>
      <Chapter
        id="alerts"
        index="10"
        title="Alert rules and routing"
        description="Committed and unit-tested in CI (promtool, amtool). Not yet deployed in any environment."
      >
        <div className="mb-4 flex flex-wrap gap-1.5" aria-label="All alert rules">
          {ALERT_RULE_NAMES.map((a) => (
            <Pill key={a.name} tone={a.severity === 'page' ? 'bad' : 'warn'}>
              {a.name} · {a.severity}
            </Pill>
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Code label="ops/prometheus/studio-alerts.yml">{ALERT_RULES}</Code>
          <Code label="ops/alertmanager/alertmanager.yml">{ALERTMANAGER}</Code>
        </div>
      </Chapter>

      <Chapter
        id="corpus"
        index="11"
        title="Corpus ingestion"
        description="Loads the 50,000-video reference library through the admin API: dry run by default, stratified sample with a review report, then a resumable full run."
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Code label="scripts/ops/ingest-corpus.ts — sample run (illustrative)">{CORPUS_RUN}</Code>
          <Code label="review report (formatReviewReport)">{CORPUS_REPORT}</Code>
        </div>
      </Chapter>

      <Chapter
        id="k6"
        index="12"
        title="Load test"
        description="k6 over the read APIs, optional draft-only writes. Pass thresholds follow spec 17.1."
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Code label="load-test/k6/studio-api.js">{K6_OPTIONS}</Code>
          <Code label="how to run (staging)">{K6_RUN}</Code>
        </div>
      </Chapter>

      <Chapter
        id="deploy"
        index="13"
        title="Deployment topology"
        description="Everything on one server, so there is one machine to run, patch and back up; forward-only migrations so version N runs on N+1’s schema during a rollback."
      >
        <Topology />
      </Chapter>

      <Chapter
        id="runbooks"
        index="14"
        title="Runbooks"
        description="Each has metric → threshold → escalation → steps, and lists its GAPs."
      >
        <Panel>
          <DataTable
            head={['File', 'Title']}
            rows={RUNBOOKS.map(([f, t]) => [
              <code key="f" className="text-xs">
                runbooks/{f}
              </code>,
              t,
            ])}
          />
        </Panel>
      </Chapter>

      <Chapter
        id="golden"
        index="15"
        title="Golden-path journeys"
        description="End-to-end tests through the real routes and workers on an inline queue and real Postgres, with scripted providers."
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {JOURNEYS.map(([file, names]) => (
            <Panel key={file} title={file} meta={`${names.length} journeys`}>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {names.map((n) => (
                  <li key={n}>
                    <span className="font-mono text-xs text-foreground">{n.split(' ')[0]}</span>{' '}
                    {n.split(' ').slice(1).join(' ')}
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      </Chapter>
    </>
  );
}
