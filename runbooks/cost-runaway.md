# Cost runaway, per organisation (priority risk 2)

| | |
| --- | --- |
| **Metric** | `studio_cost_alerts_total{scope,threshold}` (one increment per cap, period and threshold — `studio.cost_alerts`), backed by `provider_usage.costPence` per org / provider / UTC day. Shown in `GET /api/studio/admin/cost/caps` and the Admin Centre cost tab ("Caps today"). |
| **Threshold** | 80% of any cap (alert), 90% of a project budget (pause), 100% of a daily or monthly cap (pause). |
| **Alerts** | `StudioCostCapWarning` (80%, ticket), `StudioCostCapReached` (project / org daily / org monthly / provider cap reached, ticket), `StudioGlobalCostCap` (global cap at 80% or 100%, **page**) — `ops/prometheus/studio-alerts.yml`. |
| **Escalation** | On-call engineer and Finance, then the Founder at 100% of the global cap. |

## Controls that exist (spec 12.5, 11.4)

| Cap | Setting (default) | At 80% | At the limit |
| --- | --- | --- | --- |
| Project | `video_projects.costBudgetPence` (per project; PATCH `/projects/:id` or "Raise budget" on the project page). Default when the client sets none: **£3.50** short-form, **£30** long-form (any target > 180 s, or a YouTube upload > 60 s). | alert + notify the creator | **90%**: every further provider call for the project is refused; the project fails as `cost_cap_paused: …` and the creator is notified. Calls that would take it past 100% are also skipped per candidate. |
| Organisation, daily (all providers) | `STUDIO_ORG_DAILY_CAP_PENCE_<BASIC\|STANDARD\|PLUS\|ENTERPRISE>` (tier from Core's org context). Defaults £5 / £15 / £45 / £150 (plan catalogue, price list 2026-09-30). | alert + notify the organisation | **100%**: new generation pauses (`cost_cap_paused: organisation daily cost cap reached …`) until midnight UTC. Publishing of already generated videos continues. |
| Organisation, monthly (all providers, calendar month UTC) | `STUDIO_ORG_MONTHLY_CAP_PENCE_<TIER>`. Defaults £20 / £73 / £264 / £1,100. | alert + notify the organisation | **100%**: new generation pauses (`cost_cap_paused: organisation monthly cost cap reached …`) until the 1st (UTC). Publishing continues. |
| Organisation × provider, daily | `STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE` (no default) | alert + notify the organisation | **100%**: that provider is skipped; the router uses the fallback provider if there is one. |
| Global, daily (every org) | `STUDIO_GLOBAL_DAILY_CAP_PENCE`. Default £2,500. | alert + staff notification + page | **100%**: all generation pauses platform-wide until midnight UTC. Publishing continues. |

Values are operator decision 2 (2026-09-27), in code in `src/lib/studio/cost/caps.ts` and
`cost/project-budget.ts`. For the org daily / monthly and global caps an empty env value means
the default, a positive integer overrides it and `0` / `none` / `off` disables that cap (to stop
an organisation's generation outright, freeze its workspace with the kill switch instead). The
provider cap has no default (empty = no cap). The Admin Centre caps report shows each cap's
source (default / env override / disabled by env). Changing an env value needs a redeploy
(caps are read at startup).

Every alert is raised exactly once per (scope, id, period, threshold): the period is the UTC day
(daily caps), `YYYY-MM` (monthly cap), or `budget:<pence>` for a project so that raising a
budget re-arms it. The month-to-date sum reads `provider_usage` through the
`(organisationId, day)` index.
Each alert increments the metric, writes an audit event (`studio.cost.alert`), logs a
structured warning (`cost alert`) and creates a notification (organisation members, or PostMind
staff organisations in `STUDIO_PLATFORM_ORG_IDS` for the global cap), which is also sent to
`STUDIO_NOTIFY_WEBHOOK_URL` when configured.

Other limits: image generation 100 per org per day; website scans 3 active and 25 per day per
org; overlay previews 30 per project per hour.

## Steps

1. Identify the scope. Admin Centre → Cost report → "Caps today" lists the alerts of the last
   7 days, the top organisations today and the projects at or above 80% of their budget. Then
   `provider_usage` for the org and today's date.
2. If it is a legitimate customer hitting their own cap: nothing to do — generation resumes
   after midnight UTC (daily), on the 1st UTC (monthly), or when the project's budget is raised
   ("Raise budget" on the project page) and the project generated again. If Commercial agrees
   to lift (or lower) one customer's cap, use Admin Centre → **Organisations** → Cost caps (or
   `PUT /api/studio/admin/organisations/<orgId>/cost-caps { dailyPence?, monthlyPence?, reason }`,
   BACKLOG 13.19). The override wins over env and the tier default, needs a reason, is audited
   (`studio.admin.cost_caps.override`) and reaches every worker within 30 s; `null` clears it. The
   Cost report lists overrides with source `org_override`.
3. Stop runaway spend now:
   - For one org, **freeze the workspace**:
     `{"level":"workspace","target":"<orgId>","enabled":true}`.
   - If the spend is platform-wide, for example a regression looping regenerations, disable the
     offending provider, or use the global switch.
4. Diagnose:
   - Look for a retry loop in the job logs: the same `projectId` and `shotId` over and over.
   - Look for abuse, such as scripted project creation. Check the audit log for
     `studio.project.create` volume.
   - Look for a pricing error: a wrong `STUDIO_USD_TO_GBP_RATE`, or an estimate that doesn't
     match the provider invoice.
5. Fix, unfreeze, and record the incident. Finance reconciles against the provider invoices.
6. Resume paused work: projects paused by an organisation's daily or monthly cap resume on their
   own (BACKLOG 13.20): the `auto-resume-paused` job runs at 00:05 UTC every day (the 1st covers
   monthly pauses) and continues each paused run from the stage that paused, reusing paid-for work
   (audit `studio.project.auto_resume`, a notification to the creator). It skips projects whose
   owner turned "Resume automatically" off (`metadata.autoResume = false`), kill-switched ones,
   and runs with other failures. Project-budget pauses still need "Raise budget" + Generate, and
   global-cap pauses are resumed by staff (regenerate, or `redrive`). To resume early after
   raising an override, regenerate from the project page.

## Global cap

`StudioGlobalCostCap` pages at 80% so there is time to act before every organisation pauses.

1. Check whether the spend is one organisation (step 1 above) — if so, freeze it.
2. If the growth is organic and Finance agrees, raise `STUDIO_GLOBAL_DAILY_CAP_PENCE` and redeploy
   (caps are read from the environment at startup).
3. At 100% all generation is paused until midnight UTC; publishing is unaffected.

## GAPs

- **Cap values:** decided (operator decision 2, 2026-09-27) and in code as defaults; see the
  table above.
- **Per-organisation overrides:** built (13.19). An override can raise or lower a cap but never
  disables one.
- **Email:** spec 14.4 asks for email ("Cost 80% of monthly cap — email"). The monthly cap and
  its 80% alert exist, but no PostMind Core notification or email API is documented, so the
  alert is in-app plus the optional signed webhook for ops to bridge to email/Slack.
- **Paused jobs are failed, then resumed:** a paused project fails with `cost_cap_paused`; the
  rollover job resumes org daily / monthly pauses (13.20). Project-budget and global pauses are
  not resumed automatically.
- **Tier visibility:** Studio does not store an organisation's plan tier, so the admin report
  shows every tier's cap next to the org's spend; the org-daily alerts show which one fired.
- **Cost regression (spec 17.5):** built (13.31). `.github/workflows/cost-regression.yml` runs
  every Monday 06:00 UTC (and in every CI build) and fails when a golden journey's cost at the
  adapters' own prices moves more than 10 % from `test/cost/cost-baseline.json`. A failure after an
  intended price/pipeline change: update the baseline in the same PR (the failure message prints
  the new totals). An unintended one: find the price table or request that changed
  (`test/cost/journeys.ts` lists every priced call) before it reaches customers' budgets.
