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

1. Halt publishing to that platform: Admin Centre → **Kill switch** → *Halt publishing to a
   platform* (or `PUT /api/studio/admin/kill-switch` with `{"level":"platform","target":"tiktok",…}`).
   Uploads stop within 30 s; generation and other platforms continue. Publications that come due
   fail as `kill_switch_platform` with nothing posted.
2. Follow the drafted emergency comms: tell affected customers, and offer render downloads.
3. Work the appeal with the platform's partner contact. Record the timeline.
4. Once access is restored, customers may need to reconnect. Release the platform halt, then
   re-drive the halted publications: `npx tsx scripts/ops/redrive.ts kill_switch --since <halt time>
   --level platform` (review the dry run, then `--apply`), or Admin Centre → **Re-drive**. Each
   publication is retried once; ones whose connection still needs reconnecting fail again with
   `needs_reconnect` and are handled by support.

## GAPs

- The daily account-status check job is not built.
- Meta (Instagram and Facebook) publishing is blocked on credentials.
