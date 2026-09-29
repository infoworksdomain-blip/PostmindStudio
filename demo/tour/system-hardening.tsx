import { ArrowRight } from 'lucide-react';
import {
  BACKUP_REPORT,
  BACKUP_RUN_LINE,
  FAILOVER_RULE,
  JOB_LOGS,
} from './system-hardening-snippets';
import { Chapter, Code, DataTable, Panel, Pill } from './ui';

// Behind the scenes, part 5: Phase 17 reliability jobs (17.1–17.3), the provider failover alert
// (17.4), object storage on Cloudflare R2 and its nightly backup copy (17.5). Output formats follow
// services/upload-sweep.ts, lost-publications.ts, account-status.ts (pino JSON lines),
// ops/prometheus/studio-alerts.yml and ops/storage-backup-run.ts (formatReport); values are samples.

const link =
  'inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

const JOBS: [string, string, string, string, string][] = [
  [
    'sweep-abandoned-uploads',
    'studio-orchestration',
    'daily 01:45',
    'Deletes PENDING uploads older than the grace period: claims the row FAILED, deletes the object through the storage layer (S3 or R2), puts the row back if the delete fails. Anything a project, shot, slide or brand kit still references is left alone and logged.',
    'STUDIO_UPLOAD_ABANDON_GRACE_HOURS=24',
  ],
  [
    'redrive-lost-publications',
    'studio-publish',
    'every 10 min',
    'Finds SCHEDULED posts overdue by more than the margin whose own jobs are not in the queue (a crash between commit and enqueue) and enqueues them once. Skips kill-switched, deleted-project and unknown-outcome posts. Audit + warning log; the customer just sees the post go out.',
    'STUDIO_LOST_PUBLISH_MARGIN_MINUTES=15',
  ],
  [
    'check-platform-accounts',
    'studio-analytics',
    'hourly at :20',
    'One cheap read per active account, each at most once a day (≤ 100 a run, 2 s apart). Only an auth refusal flips it to needs_reconnect and notifies the owner; a transient error is recorded as unreachable; a 429 pauses that platform for the run.',
    'STUDIO_ACCOUNT_CHECK_INTERVAL_HOURS=24',
  ],
];

/** Sample 15-minute window: routing decisions that reached each provider. */
const FAILOVER: {
  provider: string;
  selected: number;
  passed: number;
  reasons: string;
  firing: boolean;
}[] = [
  {
    provider: 'runway',
    selected: 31,
    passed: 19,
    reasons: 'circuit_open 14 · too_slow 5',
    firing: true,
  },
  { provider: 'luma', selected: 52, passed: 2, reasons: 'too_slow 2', firing: false },
  { provider: 'heygen', selected: 12, passed: 0, reasons: '—', firing: false },
  { provider: 'elevenlabs', selected: 88, passed: 1, reasons: 'no_cost_estimate 1', firing: false },
];

const BUCKETS: [string, string, string][] = [
  ['studio-assets', 'S3_BUCKET_ASSETS', 'uploads, provider outputs under intermediates/, images'],
  ['studio-renders', 'S3_BUCKET_RENDERS', 'final renders'],
  ['studio-thumbnails', 'S3_BUCKET_THUMBNAILS', 'render thumbnails'],
  ['studio-library-assets', 'S3_BUCKET_LIBRARY', 'the reference library'],
];

function FailoverBars() {
  return (
    <ul className="space-y-3" aria-label="Sample failover rate per provider, last 15 minutes">
      {FAILOVER.map((f) => {
        const rate = f.passed / (f.passed + f.selected);
        const pct = Math.round(rate * 100);
        return (
          <li key={f.provider} className="grid gap-1 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono text-xs font-medium">{f.provider}</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
                {f.passed} passed over / {f.selected} selected · {pct}%
                {f.firing && <Pill tone="warn">firing · ticket</Pill>}
              </span>
            </div>
            <div className="relative h-2 overflow-hidden rounded-full bg-muted">
              <span
                className={f.firing ? 'block h-full bg-warning' : 'block h-full bg-chart-2'}
                style={{ width: `${pct}%` }}
              />
              <span
                aria-hidden
                className="absolute inset-y-0 w-px bg-foreground"
                style={{ insetInlineStart: '20%' }}
                title="20% threshold"
              />
            </div>
            <span className="text-[0.7rem] text-muted-foreground">{f.reasons}</span>
          </li>
        );
      })}
      <li className="text-[0.7rem] text-muted-foreground">
        The line marks the 20% threshold. provider_disabled (a kill switch) and over_budget (cost
        caps) are left out of the numerator: they are not outages.
      </li>
    </ul>
  );
}

function RetentionTimeline() {
  const steps: [string, string][] = [
    [
      'Day 0',
      'Source object deleted (e.g. an organisation purge). The next run records a tombstone in .studio-backup/state.json.',
    ],
    ['Days 1–29', 'The copy stays in the backup bucket, restorable. “waiting out retention”.'],
    [
      'Day 30',
      'The first run after S3_BACKUP_RETENTION_DAYS (30, also the maximum) deletes the copy: purged data is gone within 30 days + 1 run.',
    ],
  ];
  return (
    <ol className="grid gap-3 sm:grid-cols-3">
      {steps.map(([when, what], i) => (
        <li key={when} className="relative rounded-lg border border-border bg-background p-3">
          <p className="font-display text-2xl leading-none text-primary tabular-nums">{when}</p>
          <p className="mt-2 text-xs text-muted-foreground">{what}</p>
          {i < steps.length - 1 && (
            <ArrowRight
              aria-hidden
              className="absolute top-3 end-3 hidden size-4 text-muted-foreground sm:block"
            />
          )}
        </li>
      ))}
    </ol>
  );
}

export function HardeningChapters() {
  return (
    <>
      <Chapter
        id="reliability"
        index="16"
        title="Reliability jobs"
        description="Phase 17 (17.1–17.3): three scheduled jobs that clean up and catch what a crash or a revoked token would otherwise leave behind."
      >
        <ul aria-label="Phase 17 scheduled jobs" className="mb-4 grid gap-4 md:grid-cols-3">
          {JOBS.map(([job, queue, when, what, env]) => (
            <li
              key={job}
              className="flex min-w-0 flex-col rounded-xl border border-border bg-card p-4"
            >
              <p className="font-mono text-xs font-medium break-all">{job}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Pill tone="data">{queue}</Pill>
                <Pill>{when} UTC</Pill>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">{what}</p>
              <code className="mt-3 block text-[0.7rem] break-all text-foreground/80">{env}</code>
            </li>
          ))}
        </ul>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Code label="worker logs — one sample run of each job">{JOB_LOGS}</Code>
          <div className="grid content-start gap-4">
            <Panel title="Who hears about it">
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>
                  <span className="text-foreground">Account check:</span> the owner gets a
                  notification in their own language, and Connections shows the reconnect button.{' '}
                  <a href="#/connections" className={link}>
                    See it <ArrowRight aria-hidden className="size-3.5" />
                  </a>
                </li>
                <li>
                  <span className="text-foreground">Lost-publish re-drive:</span> no customer
                  notification (the real code sends none; the post simply goes out). Audit{' '}
                  <code className="text-xs">studio.publication.lost_job_redriven</code> and a
                  warning log for staff.
                </li>
                <li>
                  <span className="text-foreground">Upload sweep:</span> logs only; referenced
                  uploads are listed for a person to check.
                </li>
              </ul>
            </Panel>
            <Panel title="Re-drive skip reasons" meta="services/lost-publications.ts">
              <ul className="flex flex-wrap gap-1.5">
                {[
                  'kill_switch_engaged: <level>',
                  'project deleted',
                  'upload outcome unknown; check the platform first',
                  'schedule cancelled',
                  'publish job still queued',
                  'already re-driven once; check it by hand',
                ].map((r) => (
                  <Pill key={r}>{r}</Pill>
                ))}
              </ul>
            </Panel>
          </div>
        </div>
      </Chapter>

      <Chapter
        id="failover"
        index="17"
        title="Provider failover alert"
        description="17.4: the router now counts every provider it passes over and every one it picks, so a flapping provider raises a ticket even when its breaker never stays open for 5 minutes."
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Panel title="studio_provider_passed_over_total / selected_total" meta="sample window">
            <FailoverBars />
          </Panel>
          <Code label="ops/prometheus/studio-alerts.yml — StudioProviderFailoverRateHigh">
            {FAILOVER_RULE}
          </Code>
        </div>
      </Chapter>

      <Chapter
        id="storage"
        index="18"
        title="Object storage on Cloudflare R2"
        description="STORAGE_PROVIDER=r2 with the EU jurisdiction. AWS S3 still works (the default in code); envelope keys stay in AWS KMS."
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Panel title="Client settings" meta="src/lib/studio/storage-client.ts">
            <DataTable
              head={['Setting', 'Value']}
              rows={[
                ['STORAGE_PROVIDER', <code key="v">r2</code>],
                ['R2_JURISDICTION', <code key="v">eu</code>],
                [
                  'Endpoint',
                  <code key="v" className="text-xs break-all">
                    https://&lt;R2_ACCOUNT_ID&gt;.eu.r2.cloudflarestorage.com
                  </code>,
                ],
                ['Region', <code key="v">auto</code>],
                ['Checksums', 'WHEN_REQUIRED (R2 rejects the SDK’s default CRC32 headers)'],
                ['Presigned URLs', 'GET and PUT, at most 7 days; no CDN (CDN_URL must be empty)'],
                [
                  'Upload URLs',
                  'sign content-type and carry no checksum parameters, on R2 and (since 17.6) on S3',
                ],
                ['Encryption keys', 'AWS KMS (KMS_KEY_ID), unchanged'],
              ]}
            />
          </Panel>
          <Panel title="Buckets" meta="runbooks/r2-setup.md">
            <ul className="grid gap-2 sm:grid-cols-2">
              {BUCKETS.map(([name, env, what]) => (
                <li
                  key={name}
                  className="rounded-lg border border-border/80 bg-background px-3 py-2"
                >
                  <p className="font-mono text-xs font-medium">{name}</p>
                  <p className="text-[0.7rem] text-muted-foreground">
                    {env} · {what}
                  </p>
                </li>
              ))}
              <li className="rounded-lg border border-dashed border-primary/60 bg-primary/5 px-3 py-2 sm:col-span-2">
                <p className="font-mono text-xs font-medium">studio-backup</p>
                <p className="text-[0.7rem] text-muted-foreground">
                  S3_BACKUP_BUCKET · the backup copy (prefixes assets/, renders/, thumbnails/). Its
                  own token; the app’s token cannot read or delete it.
                </p>
              </li>
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Lifecycle (infra/r2-lifecycle.json): <code>intermediates/</code> expires after 30
              days, <code>library/staging/</code> after 2, incomplete multipart uploads after 7. R2
              has no tags, so provider outputs live under <code>intermediates/</code>.
            </p>
          </Panel>
        </div>
      </Chapter>

      <Chapter
        id="backup"
        index="19"
        title="Nightly storage backup"
        description="17.5: scripts/ops/backup-storage.ts copies new and changed objects into one backup bucket, and deletes a copy 30 days after its source was deleted, so purged data ages out."
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <Code label="npx tsx scripts/ops/backup-storage.ts --apply — nightly run (sample)">
            {BACKUP_REPORT}
          </Code>
          <div className="grid content-start gap-4">
            <Code label="the run’s JSON log line">{BACKUP_RUN_LINE}</Code>
            <Panel title="Safety valves">
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                <li>Dry run by default; the nightly job passes --apply.</li>
                <li>
                  More than 25% of a bucket (and ≥ 100 objects) newly missing, or an empty listing,
                  stops that bucket unless --allow-mass-tombstone.
                </li>
                <li>A corrupt state file fails the run instead of resetting the clocks.</li>
                <li>Any copy or delete error: exit 1, and the next run retries.</li>
              </ul>
            </Panel>
          </div>
        </div>
        <div className="mt-4">
          <RetentionTimeline />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          On the server, the database is backed up to the same R2 backup bucket every night too (see
          Deployment).
        </p>
      </Chapter>
    </>
  );
}
