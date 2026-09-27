# Platform account revocation — Meta, TikTok, YouTube (priority risk 7)

| | |
| --- | --- |
| **Metric** | Platform connection state: `platform_connections.state` = `needs_reconnect` or `revoked`. Publish errors with `errorClass=needs_reconnect`. |
| **Threshold** | Any account in a warning state. For a revocation of **our app**, the threshold is any occurrence. |
| **Escalation** | On-call engineer, then Product. For app-level problems, also the Founder and the platform partner manager. |

## A customer's connection

A refresh failure or a 401 marks the connection `needs_reconnect`. Publishing to it stops with a
clear error, and `/connections` shows a Reconnect button. No operator action is needed beyond
support.

## Our app is restricted or revoked (app review, policy strike)

1. Freeze publishing for that platform. Disable its publish path by pausing the scheduled
   publications for that platform.
2. Follow the drafted emergency comms: tell affected customers, and offer render downloads.
3. Work the appeal with the platform's partner contact. Record the timeline.
4. Once access is restored, customers may need to reconnect. Retry the scheduled publications.

## GAPs

- There is no per-platform kill switch. The existing levels are global, workspace, project and
  provider (generation providers only). Pausing one publishing platform means a targeted script
  or a hotfix. Proposed follow-up: add a `platform` kill-switch level.
- The daily account-status check job is not built.
- Meta (Instagram and Facebook) publishing is blocked on credentials.
