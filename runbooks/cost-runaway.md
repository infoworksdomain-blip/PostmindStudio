# Cost runaway, per organisation (priority risk 2)

| | |
| --- | --- |
| **Metric** | Per-org, per-provider daily spend (`provider_usage.costPence`), shown in `GET /api/studio/admin/cost` and the Admin Centre cost tab. |
| **Threshold** | More than 80% of the daily cap. |
| **Escalation** | On-call engineer and Finance, then the Founder at 100%. |

## Controls that exist

- **Project hard cap:** `video_projects.costBudgetPence`. The router refuses any provider call
  that would exceed it (spec 12.5).
- **Per-org, per-provider daily cap:** `STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE`, applied per UTC day
  as a hard ceiling (spec 11.4).
- **Rate limits:**
  - Image generation: 100 per org per day.
  - Website scans: 3 active and 25 per day per org.
  - Overlay previews: 30 per project per hour.

## Steps

1. Identify the org, the provider and the projects. Use the admin cost report, then
   `provider_usage` for the org and today's date.
2. Stop the spend now:
   - For one org, **freeze the workspace**:
     `{"level":"workspace","target":"<orgId>","enabled":true}`.
   - If the spend is platform-wide, for example a regression looping regenerations, disable the
     offending provider, or use the global switch.
3. Diagnose:
   - Look for a retry loop in the job logs: the same `projectId` and `shotId` over and over.
   - Look for abuse, such as scripted project creation. Check the audit log for
     `studio.project.create` volume.
   - Look for a pricing error: a wrong `STUDIO_USD_TO_GBP_RATE`, or an estimate that doesn't
     match the provider invoice.
4. Fix, unfreeze, and record the incident. Finance reconciles against the provider invoices.

## GAPs

- The 80% and 100% **alerts** and the spec 12.5 "pause at 90% and notify" automation are **not
  implemented**. Today the caps are hard stops only.
- Per-tier caps are not defined, so the cap stays unset by default until Product sets them.
- The weekly cost regression test (spec 17.5) is still to be scheduled.
