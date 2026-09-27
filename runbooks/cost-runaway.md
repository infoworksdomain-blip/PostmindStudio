# Cost runaway, per organisation (priority risk 2)

| | |
| --- | --- |
| **Metric** | `studio_cost_alerts_total{scope,threshold}` (one increment per cap, period and threshold — `studio.cost_alerts`), backed by `provider_usage.costPence` per org / provider / UTC day. Shown in `GET /api/studio/admin/cost/caps` and the Admin Centre cost tab ("Caps today"). |
| **Threshold** | 80% of any cap (alert), 90% of a project budget (pause), 100% of a daily cap (pause). |
| **Alerts** | `StudioCostCapWarning` (80%, ticket), `StudioCostCapReached` (project / org / provider cap reached, ticket), `StudioGlobalCostCap` (global cap at 80% or 100%, **page**) — `ops/prometheus/studio-alerts.yml`. |
| **Escalation** | On-call engineer and Finance, then the Founder at 100% of the global cap. |

## Controls that exist (spec 12.5, 11.4)

| Cap | Setting | At 80% | At the limit |
| --- | --- | --- | --- |
| Project | `video_projects.costBudgetPence` (per project; PATCH `/projects/:id`) | alert + notify the creator | **90%**: every further provider call for the project is refused; the project fails as `cost_cap_paused: …` and the creator is notified. Calls that would take it past 100% are also skipped per candidate. |
| Organisation, daily (all providers) | `STUDIO_ORG_DAILY_CAP_PENCE_<BASIC\|STANDARD\|PLUS\|ENTERPRISE>` (tier from Core's org context) | alert + notify the organisation | **100%**: new generation pauses (`cost_cap_paused: organisation daily cost cap reached …`) until midnight UTC. Publishing of already generated videos continues. |
| Organisation × provider, daily | `STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE` | alert + notify the organisation | **100%**: that provider is skipped; the router uses the fallback provider if there is one. |
| Global, daily (every org) | `STUDIO_GLOBAL_DAILY_CAP_PENCE` | alert + staff notification + page | **100%**: all generation pauses platform-wide until midnight UTC. Publishing continues. |

Unset = no cap. Every alert is raised exactly once per (scope, id, period, threshold): the
period is the UTC day, or `budget:<pence>` for a project so that raising a budget re-arms it.
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
   after midnight UTC, or when the project's budget is raised and the project regenerated.
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
6. Resume paused work: projects paused by a cap are FAILED with `cost_cap_paused`; the owner
   (or support) regenerates them once the cap allows it.

## Global cap

`StudioGlobalCostCap` pages at 80% so there is time to act before every organisation pauses.

1. Check whether the spend is one organisation (step 1 above) — if so, freeze it.
2. If the growth is organic and Finance agrees, raise `STUDIO_GLOBAL_DAILY_CAP_PENCE` and redeploy
   (caps are read from the environment at startup).
3. At 100% all generation is paused until midnight UTC; publishing is unaffected.

## GAPs

- **Cap values:** per-tier organisation caps and the global cap are not decided by Product /
  Finance, so they are unset (no cap) by default.
- **Email:** spec 14.4 asks for email ("Cost 80% of monthly cap — email"). No PostMind Core
  notification or email API is documented, so notifications are in-app plus an optional signed
  webhook for ops to bridge to email/Slack. The spec's *monthly* cap is not defined anywhere;
  Studio implements the daily caps of 12.5.
- **Paused jobs are failed, not delayed:** a paused project fails with `cost_cap_paused` and has
  to be regenerated; it does not resume on its own at midnight.
- **Tier visibility:** Studio does not store an organisation's plan tier, so the admin report
  shows every tier's cap next to the org's spend; the org-daily alerts show which one fired.
- The weekly cost regression test (spec 17.5) is still to be scheduled.
