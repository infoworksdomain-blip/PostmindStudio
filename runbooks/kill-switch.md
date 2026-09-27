# Kill switch (spec §12, playbook §11.4)

Four levels, all stored in `studio.system_flags`:

| Level | Stops |
| --- | --- |
| Global | Every Studio job, for every org |
| Workspace freeze | One organisation's jobs |
| Project | One project's jobs |
| Provider | Routing to that provider (the router fails over to the next candidate) |

Workers check the flags when a job starts. A job that starts while its scope is killed fails
**permanently** with the reason `kill_switch_<level>`. It is not retried, and the job's failure
handler runs, so the project or publication ends with that `errorReason`. Jobs that were already
running when the switch was engaged finish normally. The flags are cached for 30 s, so a change reaches
every worker within 30 s. The Admin API invalidates its own cache immediately.

**SLO: 60 s from engaging the switch to all affected work halting.** A breach blocks launch.

## Engage

**UI:** go to `/admin`, open **Kill switch**, choose the level and target, and give a reason. A
global kill requires typing the confirmation.

**API** (platform staff token):

```bash
curl -X PUT "$STUDIO_URL/api/studio/admin/kill-switch" \
  -H "authorization: Bearer $STAFF_TOKEN" -H "content-type: application/json" \
  -H "idempotency-key: $(uuidgen)" \
  -d '{"level":"global","enabled":true,"reason":"INC-123: <why>"}'
```

- **Workspace:** `{"level":"workspace","target":"<organisationId>", ...}`.
- **Project:** `{"level":"project","target":"<projectId>", ...}`.
- **Provider:** `{"level":"provider","target":"runway", ...}`. The target must be a known
  provider id.

Every change writes an audit event: `studio.kill_switch.engage` or `studio.kill_switch.release`.

## Verify

1. Run `GET /api/studio/admin/kill-switch`. It shows the level as enabled, with its `since` time.
2. For a global kill, watch `sum(studio_queue_jobs{state="active"})`. It must reach 0 within 60 s.
3. Publishing halts: no new `publish-video` successes appear in `studio_jobs_total`.
4. Affected projects and publications show `errorReason` = `kill_switch_<level>`. Other
   organisations are unaffected, except under a global kill.

## Release

Send the same call with `"enabled": false`. Work that failed while the switch was engaged does
**not** resume on its own:

1. List the affected projects: `errorReason LIKE 'kill_switch_%'`, updated since the engage time.
2. Regenerate them. The generate endpoint starts a new run.
3. Retry the affected publications: `POST /publications/<id>/retry`.
4. Confirm that new generations complete.

**GAP:** there is no bulk re-drive tool yet.

## Rehearsal (BACKLOG 12.2) — staging only

```bash
STUDIO_URL=https://studio-staging.postmind.ai STUDIO_STAFF_TOKEN=... \
METRICS_URL=https://studio-staging.internal/api/metrics METRICS_TOKEN=... \
npx tsx scripts/ops/rehearse-kill-switch.ts global
```

The global run times the drain and prints PASS or FAIL against the 60 s SLO, with the samples. It
always releases the switch afterwards.

Run each of the other levels as well. Each run engages the switch, waits the 30 s propagation
window, and releases on Enter:

- `workspace <orgId>`: the frozen org's new jobs are halted while other orgs continue.
- `provider runway`: new shots route to the fallback provider (Luma).
- `project <projectId>`: that project's jobs are skipped.

Put the system under load first by running the k6 smoke profile plus a few real generations. The
switch has to work under load. For each level, record the date, the operator, the level and the
measured time in PROGRESS.md (GATE 12).
