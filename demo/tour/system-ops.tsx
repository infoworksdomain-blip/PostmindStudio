import { Bell } from 'lucide-react';
import { DEMO_ORG_ID, PROJECTS } from '../api/ids';
import { Chapter, Code, DataTable, Panel, Pill } from './ui';

// Behind the scenes, part 2: kill switch + rehearsal, bulk re-drive, cost caps and alerts.
// Sources: system-flags.ts, kill-switch.ts, ops/rehearsal.ts (formatReport),
// ops/redrive-cli.ts (formatRedriveReport), services/redrive.ts, cost/caps.ts, cost/guard.ts
// (alertMessage), notifications/sender.ts (webhook contract).

const LEVELS: [string, string, string][] = [
  [
    '1 · global',
    'studio.killSwitch',
    'All generation and publishing halt. Typed confirmation in the Admin Centre; pages on-call.',
  ],
  [
    '2 · workspace',
    'studio.frozenWorkspace.<organisationId>',
    'One organisation frozen; every other keeps processing.',
  ],
  ['3 · project', 'studio.killedProject.<projectId>', 'One project’s jobs stop.'],
  [
    '4 · provider',
    'studio.disabledProvider.<providerId>',
    'The router skips it (provider_disabled) and uses the fallback.',
  ],
  [
    '5 · platform',
    'studio.kill_switch.platform.<platform>',
    'Publishing to one platform halts before upload; generation is unaffected.',
  ],
];

// formatReport() output for a global rehearsal (sample timings; the staging run is still to do).
const REHEARSAL = `$ STUDIO_URL=https://studio-staging.postmind.ai STUDIO_STAFF_TOKEN=… \\
  METRICS_URL=https://studio-staging.internal/api/metrics METRICS_TOKEN=… \\
  npx tsx scripts/ops/rehearse-kill-switch.ts global
Kill-switch rehearsal: level=global
PASS — drained in 41.5s (SLO 60s)
Samples (s → active jobs by queue):
     0.0  {"studio-orchestration":6,"studio-assets":14,"studio-publish":2}
    10.1  {"studio-orchestration":3,"studio-assets":9,"studio-publish":0}
    20.2  {"studio-orchestration":1,"studio-assets":4,"studio-publish":0}
    30.4  {"studio-orchestration":0,"studio-assets":1,"studio-publish":0}
    41.5  {"studio-orchestration":0,"studio-assets":0,"studio-publish":0}
(the switch is released afterwards, even on failure)`;

// formatRedriveReport() output (sample ids from the demo business).
const REDRIVE = `$ npx tsx scripts/ops/redrive.ts kill_switch --since 2026-09-27T09:00:00Z --level workspace
Re-drive (kill_switch) — DRY RUN, nothing changed
4 considered, would re-drive 3, skipped 1
  project     ${PROJECTS.loyaltyCard.id}  org=${DEMO_ORG_ID}  resume_assets → generate-asset, generate-asset
  project     ${PROJECTS.springMenu.id}  org=${DEMO_ORG_ID}  resume_planning → plan-project
  publication pub-wholesale-linkedin  org=${DEMO_ORG_ID}  retry_publication → publish-video
  publication pub-class-reels  org=${DEMO_ORG_ID}  skipped: upload outcome unknown; check the platform first
Run again with --apply to execute.`;

const WEBHOOK = `POST https://ops-bridge.example/studio        (STUDIO_NOTIFY_WEBHOOK_URL)
content-type: application/json
X-Studio-Timestamp: 1790500215
X-Studio-Signature: v1=HMAC-SHA256(STUDIO_NOTIFY_WEBHOOK_SECRET, "1790500215.<raw body>")

{
  "type": "studio.notification",
  "id": "ntf_01J9Q4X7R2",
  "audience": "organisation",
  "organisationId": "${DEMO_ORG_ID}",
  "userId": null,
  "kind": "cost_alert",
  "title": "80% of this month’s generation budget used",
  "body": "£58.40 of £73.00 spent this month (UTC). Generation pauses at 100% until the 1st (UTC); publishing is not affected.",
  "link": "https://studio.postmind.ai/analytics",
  "createdAt": "2026-09-27T09:10:15.000Z"
}
# Best effort: one attempt, 5 s timeout. Receivers should reject timestamps older than 5 minutes.`;

const TIERS: [string, string, string][] = [
  ['BASIC', '£5', '£20'],
  ['STANDARD', '£15', '£73'],
  ['PLUS', '£45', '£264'],
  ['ENTERPRISE', '£150', '£1,100'],
];

function CostCaps() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-4">
        <Panel
          title="Organisation caps by plan tier"
          meta="provider spend, GBP · env overrides; 0/none/off disables"
        >
          <DataTable
            head={['Tier', 'Daily (UTC)', 'Monthly (UTC)']}
            rows={TIERS.map(([t, d, m]) => [
              <Pill key="t" tone="data">
                {t}
              </Pill>,
              d,
              m,
            ])}
          />
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              ['Global daily', '£2,500'],
              ['Short-form budget', '£3.50'],
              ['Long-form budget', '£30'],
              ['Long-form means', '> 180 s'],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg bg-muted p-2.5">
                <dt className="text-[0.7rem] text-muted-foreground">{k}</dt>
                <dd className="font-display text-2xl leading-tight">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel title="What happens as spend climbs">
          <div className="relative mt-2 h-3 rounded-full bg-muted" aria-hidden>
            <div className="absolute inset-y-0 left-0 w-[80%] rounded-full bg-chart-1/40" />
            {[80, 90, 100].map((x) => (
              <span
                key={x}
                className="absolute -top-1 h-5 w-0.5 bg-foreground"
                style={{ left: `calc(${x}% - 1px)` }}
              />
            ))}
          </div>
          <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            <li>
              <Pill tone="warn">80%</Pill>{' '}
              <span className="text-muted-foreground">
                alert once: in-app, audit, metric, webhook
              </span>
            </li>
            <li>
              <Pill tone="bad">90%</Pill>{' '}
              <span className="text-muted-foreground">
                a project pauses (cost_cap_paused); Raise budget, Generate again
              </span>
            </li>
            <li>
              <Pill tone="bad">100%</Pill>{' '}
              <span className="text-muted-foreground">
                daily / monthly / global caps pause generation; publishing never pauses
              </span>
            </li>
          </ul>
        </Panel>
      </div>
      <div className="min-w-0 space-y-4">
        <Panel title="The notification" meta="bell · org-wide">
          <div className="flex gap-3 rounded-lg border border-border p-3">
            <Bell aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
            <div>
              <p className="text-sm font-medium">
                Generation paused: “{PROJECTS.christmas.name}” reached 90% of its budget
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                £21.60 of £24.00 spent. Open the project, raise its budget (Raise budget), then
                press Generate again.
              </p>
              <a
                href={`#/projects/${PROJECTS.christmas.id}`}
                className="mt-1 inline-block text-xs font-medium text-primary hover:underline"
              >
                Open the paused project
              </a>
            </div>
          </div>
        </Panel>
        <Code label="signed webhook (notifications/sender.ts contract)">{WEBHOOK}</Code>
      </div>
    </div>
  );
}

export function OpsChapters() {
  return (
    <>
      <Chapter
        id="kill-switch"
        index="04"
        title="Kill switch: five levels"
        description="All levels live in system_flags, are checked at every job start (30 s cache) and fail closed on unknown values. The Admin Centre engages and releases them."
      >
        <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <Panel>
            <DataTable
              head={['Level', 'Flag key', 'Effect']}
              rows={LEVELS.map(([l, k, e]) => [
                <span key="l" className="font-medium whitespace-nowrap">
                  {l}
                </span>,
                <code key="k" className="text-[0.7rem]">
                  {k}
                </code>,
                <span key="e" className="text-muted-foreground">
                  {e}
                </span>,
              ])}
            />
          </Panel>
          <Code label="timed rehearsal — sample output (scripts/ops/rehearse-kill-switch.ts)">
            {REHEARSAL}
          </Code>
        </div>
      </Chapter>

      <Chapter
        id="redrive"
        index="05"
        title="Bulk re-drive"
        description="After a kill switch or a Redis loss, re-drive resumes work from the stage that stopped, under a new run, so finished shots are never paid for twice. Dry run by default; the same engine backs the Admin Centre Re-drive tab."
      >
        <Code label="scripts/ops/redrive.ts — sample output">{REDRIVE}</Code>
        <p className="mt-3 text-xs text-muted-foreground">
          Scopes: <code>kill_switch</code> (since a time, optionally one level or organisation) and{' '}
          <code>stuck</code> (active projects idle ≥ 30 min by default, re-enqueued under their
          current run). Every call is audited as <code>studio.redrive.run</code>.
        </p>
      </Chapter>

      <Chapter
        id="cost"
        index="06"
        title="Cost caps and alerts"
        description="Checked before every provider routing and after every reservation. Values are operator decision 2 (27 Sept 2026)."
      >
        <CostCaps />
      </Chapter>
    </>
  );
}
