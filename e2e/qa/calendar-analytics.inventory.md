# QA 5 inventory: Calendar and Analytics

Scope: `/calendar`, `/analytics`, `/analytics/publications/[id]` and the API routes behind them.

## Calendar (`src/components/studio/calendar/*`)

| Item                          | Kind         | Notes                                                                                           |
| ----------------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `/calendar` page              | page         | `PublicationsCalendar`; browser-local time zone for every date                                  |
| Month grid (md+)              | component    | 7 columns, Monday first, 4-6 rows; cap per cell `MAX_PER_CELL` (now 4)                          |
| Agenda list (<md, 375 px)     | component    | days with something on them; empty text "Nothing scheduled or published this month."           |
| Week view, day view           | NOT PRESENT  | the calendar is month + agenda only (gap, reported not built)                                   |
| Previous / Today / Next month | buttons      | no upper bound on navigation; open-slot data stops at the drip horizon                          |
| `CalendarEvent`               | component    | per-state rule colour, platform label, link to `/projects/:id`, move button for SCHEDULED       |
| Drag to day                   | interaction  | HTML5 DnD, same local time of day (`moveToDay`), PATCH `/publications/:id`                      |
| `MoveToDialog`                | dialog       | `datetime-local`, 1 minute lead checked client side, 180 days checked server side               |
| `OpenSlot`, `PlannedSlot`     | components   | drip-queue open slots; month-plan items (link to `/plans/:id`)                                  |
| `MonthAheadSummary`           | text         | "Next 30 days: N posts scheduled, M open slots" / queue-off variant                             |
| `DripQueuePanel`              | form         | presets, slot day/time, add/remove, Save (schedule settings: owned by p20-posting-schedule)     |
| Truncation notice             | status       | after `MAX_PAGES` x 200 publications                                                            |
| States                        |              | loading skeleton, error + Retry, empty (mobile text only), success, refreshing spinner          |
| API                           | routes       | GET `/publications?from&to&state`, PATCH `/publications/:id`, GET/PUT `/businesses/:id/drip-queue`, GET `.../drip-queue/upcoming` |

## Analytics (`src/components/studio/analytics/*`)

| Item                           | Kind                     | Notes                                                                          |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------ |
| Range filter 7 / 30 / 90 days  | radio group              | no custom range                                                                |
| `OverviewStrip`                | KPIs                     | views, watch time, engagement (+rate), shares/saves, spend                     |
| `TrendSection`                 | area chart               | views / watch time / engagement; keyboard + pointer readout; sr-only table     |
| `PlatformBreakdown`            | bar list                 | views per platform                                                             |
| `Leaderboard`                  | list                     | top 10 by views; links to per-publication page and platform URL                |
| `CostSection`                  | area chart + 2 bar lists | by day, provider, project (project shown as a raw id)                          |
| `/analytics/publications/[id]` | page                     | stats, views over time, YouTube retention, audience age/gender, empty state    |
| Best times                     | API + publish panel only | GET `/analytics/best-times`; no UI on `/analytics`                             |
| Engagement sentiment           | lib + API only          | GET `/analytics/engagement-conversations`; no UI on `/analytics`               |
| Export                         | NOT PRESENT              | no analytics export                                                            |
| States                         |                          | loading skeletons, per-section error + Retry, empty text per section, partial data |
| API                            | routes                   | overview, timeseries, leaderboard, cost, publications/[id], best-times, engagement-conversations |

## Cross-cutting states

Empty, loading, error, success, permission-denied (403 mocked), mobile 375 px, dark mode, RTL (`ar`), time zones
(Europe/London, America/Los_Angeles), DST boundaries (London 2026-10-25).

## Counts

Calendar: 13 UI items, 5 API routes. Analytics: 12 UI items, 7 API routes. Not present: week view, day view, analytics
export, analytics UI for best times / sentiment.
