# On-call (BACKLOG 14.11)

| | |
| --- | --- |
| **Metric** | Any Alertmanager alert with `severity=page` (PagerDuty) or `severity=ticket` (Slack `#studio-alerts`), from `ops/prometheus/studio-alerts.yml`. |
| **Threshold** | A page must be acknowledged within 5 minutes. |
| **Escalation** | Primary → secondary (15 min) → engineering lead (30 min), per the PagerDuty escalation policy mirrored from `ops/oncall/rota.template.yaml`. |

## Set-up (people work before GA)

1. Copy `ops/oncall/rota.template.yaml`, fill in the people, and keep the filled copy **out of this
   repository** (names and phone numbers). At least 4 engineers on primary.
2. In PagerDuty, create:
   - the schedules from `schedules` (primary, secondary, trust-and-safety);
   - an escalation policy from `escalation`;
   - a service using that policy with an **Events API v2** integration. Its routing key is the file
     Alertmanager reads (`/etc/alertmanager/secrets/pagerduty-routing-key`).
   PagerDuty docs: schedules <https://support.pagerduty.com/main/docs/schedule-basics>,
   escalation policies <https://support.pagerduty.com/main/docs/escalation-policies>.
3. Create the Slack webhook for `#studio-alerts` (`/etc/alertmanager/secrets/slack-webhook-url`).
4. Test the path end to end on staging: fire a test alert through Alertmanager (for example
   `amtool alert add alertname=OnCallTest severity=page --alertmanager.url=<url>`) and check that
   primary is paged, and that an unacknowledged page reaches secondary after 15 minutes.

Alertmanager routing is **not** where escalation lives: `ops/alertmanager/alertmanager.yml`
routes `severity=page` to PagerDuty and `severity=ticket` to Slack, nothing more. Do not add
per-person routes there; change the PagerDuty escalation policy (and this template) instead.

## Severity

| Severity | Meaning | Response |
| --- | --- | --- |
| page | Customers are affected now, or money / safety is at risk (target down, global kill switch, cost cap breach, dead letter growing fast). | Acknowledge ≤ 5 min; post in `#studio-incidents` ≤ 15 min; follow the alert's `runbook_url`. |
| ticket | Degraded or trending badly (latency, backlog, failure rate). | Triage next working day; open a ticket. |

## During a page

1. **Acknowledge** in PagerDuty.
2. Open the alert's runbook (every alert carries `runbook_url`; the index is
   [README.md](README.md)).
3. **Stop the bleeding first**: the kill switch ([kill-switch.md](kill-switch.md)) halts spend and
   publishing within 60 s at any level; a bad deploy is rolled back ([rollback.md](rollback.md)).
4. Post status in `#studio-incidents` every 30 minutes until resolved.
5. Escalate early: secondary for a second pair of hands, the engineering lead for customer
   comms or anything touching money, Trust & Safety for content, the Core on-call for
   internal-API or purge failures (`integrations/core/retry-alerting.md`).
6. After recovery: re-drive halted work ([kill-switch.md](kill-switch.md) "Re-drive"), resolve the
   alert, and write a short incident note (timeline, cause, follow-ups) within 2 working days.

## Handover (weekly, Monday 10:00 Europe/London)

- Open pages and tickets, anything silenced, kill switches still engaged
  (`GET /api/studio/admin/kill-switch`), pending safety reviews and the current month's safety
  audit progress (Admin Centre → **Safety review** / **Safety audit**).
- Beta customers with open feedback marked `bug` (Admin Centre → **Beta**).

## Verification

- The quarterly review in `rota.template.yaml` (`last_reviewed`) is current.
- A test page reached primary and escalated to secondary on staging this quarter.

**GAP (people):** the rota must be staffed and PagerDuty configured before GA; nothing in code
can do that.
