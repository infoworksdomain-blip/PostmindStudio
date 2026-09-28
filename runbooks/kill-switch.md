# Kill switch (spec §12, playbook §11.4)

Four levels plus a per-platform publishing halt, all stored in `studio.system_flags`:

| Level | Stops |
| --- | --- |
| Global | Every Studio job, for every org |
| Workspace freeze | One organisation's jobs |
| Project | One project's jobs |
| Provider | Routing to that provider (the router fails over to the next candidate) |
| Platform | Publishing to one platform (`tiktok`, `youtube_short`, …). Generation and other platforms continue. Key `studio.kill_switch.platform.<platform>` |

Workers check the flags when a job starts. A job that starts while its scope is killed fails
**permanently** with the reason `kill_switch_<level>`. It is not retried, and the job's failure
handler runs, so the project or publication ends with that `errorReason`. Jobs that were already
running when the switch was engaged finish normally. The flags are cached for 30 s, so a change reaches
every worker within 30 s. The Admin API invalidates its own cache immediately.

**SLO: 60 s from engaging the switch to all affected work halting.** A breach blocks launch.

## Engage

**UI:** go to `/admin`, open **Kill switch**, choose the level and target, and give a reason. A
global kill requires typing the confirmation and a second staff member's approval (below).

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
- **Platform:** `{"level":"platform","target":"tiktok", ...}`. The target must be one of the
  publishing platforms (`tiktok`, `instagram_reel`, `youtube_short`, `youtube`, `linkedin_video`,
  `x`, `facebook`). `publish-video` and `fire-scheduled-publication` check it before anything is
  uploaded (before the `uploadStartedAt` marker is written), so a halted publication fails as
  `kill_switch_platform` with nothing posted, and is safe to re-drive. The Admin Centre lists it
  under **Halted platforms**; `GET` returns it as `disabledPlatforms`.

Every change writes an audit event: `studio.kill_switch.engage` or `studio.kill_switch.release`.

### Global kill: two-person approval (BACKLOG 15.D6, spec 19.2)

Engaging the **global** level needs two PostMind staff members:

1. The first sends the PUT above. It answers **202** with
   `{"pending":{"requestId","requestedBy","reason","requestedAt","expiresAt"}}` and changes
   nothing yet (audit `studio.kill_switch.global_requested`). The request lives in its own
   `system_flags` row, `studio.pendingGlobalKill`; the `studio.killSwitch` flag is untouched.
2. A **different** staff user confirms within **10 minutes** (UI: the amber *Global kill waiting
   for a second approver* banner → **Confirm and halt Studio**):

   ```bash
   curl -X POST "$STUDIO_URL/api/studio/admin/kill-switch/global/confirm" \
     -H "authorization: Bearer $SECOND_STAFF_TOKEN" -H "content-type: application/json" \
     -H "idempotency-key: $(uuidgen)" \
     -d '{"requestId":"<from the 202>","reason":"INC-123: agreed"}'
   ```

   The flag is set at once (audit `studio.kill_switch.engage` with `twoPerson: true`,
   `requestedBy`, `confirmedBy`). The requester gets **403**; an expired or replaced request
   **409** (request it again); nothing pending **404**. Only one request can be pending (409).
3. Withdraw a request with `DELETE /api/studio/admin/kill-switch/global/pending` (UI:
   **Withdraw request**; audit `studio.kill_switch.global_request_withdrawn`).

The 60 s SLO starts at the confirmation. **Releasing** the global kill stays one person: it
restores service. Workspace, project, provider and platform levels are unchanged (one person).

**Break-glass** (no second staff member reachable during a P0): set
`STUDIO_KILL_SWITCH_SINGLE_APPROVER=true` on the API and redeploy/restart; the PUT then engages
at once (200 with `"breakGlass": true`, audit `studio.kill_switch.engage` with `breakGlass: true`
and a warning log). Unset it again straight after the incident and note it in the postmortem.

## Verify

1. Run `GET /api/studio/admin/kill-switch`. It shows the level as enabled, with its `since` time.
2. For a global kill, watch `sum(studio_queue_jobs{state="active"})`. It must reach 0 within 60 s.
3. Publishing halts: no new `publish-video` successes appear in `studio_jobs_total`.
4. Affected projects and publications show `errorReason` = `kill_switch_<level>`. Other
   organisations are unaffected, except under a global kill.

## Release

Send the same call with `"enabled": false`. Work that failed while the switch was engaged does
**not** resume on its own. Re-drive it:

**UI:** `/admin` → **Re-drive** → scope *Kill-switched work*, the level, *Failed since* = the engage
time (at most 30 days back), optionally an organisation → **Preview** (a dry run: nothing changes)
→ check the table → **Apply** → confirm.

**CLI** (staff token; dry run unless `--apply`):

```bash
STUDIO_URL=... STUDIO_STAFF_TOKEN=... npx tsx scripts/ops/redrive.ts kill_switch --since 2026-09-27T09:00:00Z --level workspace [--org <id>]
# review the plan, then the same command with --apply
```

**API:** `POST /api/studio/admin/redrive` with
`{"scope":"kill_switch","since":"<ISO>","level":"workspace","organisationId":"<id>","dryRun":true,"limit":100}`
(capability `studio:admin:redrive`, platform staff organisation). Every call — dry run or not —
writes a `studio.redrive.run` audit event with the filter and the counts.

What the re-drive does, per item:

- **Project failed at planning** (`planning_failed: kill_switch_…`): back to `QUEUED` under a new
  run, `plan-project` enqueued.
- **Project failed at assets, composition or the quality gate**: back to `ASSETS_QUEUED` under a new
  run. Shots that already have assets stay `READY` and are **not** regenerated; only the
  kill-switched shots are reset and re-generated. Finished renders are kept (compose skips them),
  so a project killed at the quality gate re-runs only the gate. No provider is paid twice for work
  that finished.
- **Publication** (`kill_switch_…`, including `scheduling failed: kill_switch_…`): retried through
  the same path as `POST /publications/<id>/retry` — once; a second re-drive finds nothing.

Skipped and reported, never regenerated wholesale:

- the switch that stopped it (or any other level covering it) is **still engaged**;
- a shot of the project also failed for another reason (fix and regenerate it by hand);
- a failure stage the tool cannot place, or a run without a recorded plan tier (runs started
  before this release — regenerate those from the project page);
- a publication whose upload had already started (`uploadStartedAt`): the post may be live, so a
  person checks the platform first and uses the normal retry.

Then confirm that the re-driven projects reach `READY_FOR_REVIEW` and publications `PUBLISHED`.

## Rehearsal (BACKLOG 12.2) — staging only

```bash
STUDIO_URL=https://studio-staging.postmind.ai STUDIO_STAFF_TOKEN=... \
STUDIO_CONFIRMER_TOKEN=<a second staff user's staging JWT> \
METRICS_URL=https://studio-staging.internal/api/metrics METRICS_TOKEN=... \
npx tsx scripts/ops/rehearse-kill-switch.ts global
```

The global run requests the kill with `STUDIO_STAFF_TOKEN`, confirms it with
`STUDIO_CONFIRMER_TOKEN` (15.D6: it must be a different staff user; the script stops before
engaging anything if the variable is missing), then times the drain from the confirmation and prints PASS or FAIL against the 60 s SLO, with the samples. It
always releases the switch afterwards.

Run each of the other levels as well. Each run engages the switch, waits the 30 s propagation
window, and releases on Enter:

- `workspace <orgId>`: the frozen org's new jobs are halted while other orgs continue.
- `provider runway`: new shots route to the fallback provider (Luma).
- `project <projectId>`: that project's jobs are skipped.
- Platform level (not in the rehearsal script): halt `tiktok` from the Admin Centre, schedule a
  TikTok and a YouTube post, confirm TikTok fails as `kill_switch_platform` while YouTube publishes,
  release, then re-drive with `--level platform` and confirm the TikTok post goes out once.

Put the system under load first by running the k6 smoke profile plus a few real generations. The
switch has to work under load. For each level, record the date, the operator, the level and the
measured time in PROGRESS.md (GATE 12).

## Feature flags (BACKLOG 15.D1, Addendum A12.4)

Softer than a kill switch: turn one v1.1 feature off while everything else keeps working.
Features: `library` (reference video library), `overlays` (text overlays), `slideshow`,
`image-library`.

- **Admin Centre → Features**, or `PUT /api/studio/admin/features`
  `{ "feature": "slideshow", "scope": "global" | "organisation", "organisationId"?, "enabled": false, "reason": "…" }`
  (staff only, audited as `studio.feature.disable` / `studio.feature.enable`). A global switch-off
  asks for the feature name to be typed.
- Takes effect within **30 s** in every process (same flag cache TTL as the kill switch).
- Users get `403 { error: "feature_disabled", details: { feature, scope } }`; slideshow and
  library-reference project creation is refused; `populate-slideshow` / `refresh-image-library`
  jobs stop without retries (re-drive them after re-enabling). Staff library curation routes are
  never gated.
- `FEATURE_<NAME>_ENABLED="false"` in the environment hard-disables a feature (the Admin toggle
  cannot override it; the Features tab shows "Off by environment").
- Re-enable: the same call with `enabled: true` (an organisation override is deleted).
