import { CONNECTIONS, DEMO_ORG_ID, PUBLICATIONS } from '../api/ids';

// Sample output for #/tour/system chapters 16–19, in the exact format the code prints:
//   pino JSON lines (src/lib/logger.ts: level, time, service, …fields, msg) from
//   services/upload-sweep.ts, services/lost-publications.ts, services/account-status.ts;
//   ops/prometheus/studio-alerts.yml (verbatim excerpt);
//   ops/storage-backup-run.ts formatReport() and the storage_backup_run log line.
// Timestamps and counts are samples.

const DAY_MS = 86_400_000;
// Yesterday, so every sample time is in the past.
const today = new Date(Date.now() - DAY_MS);
const utc = (hh: number, mm: number, ss = 0, daysAgo = 0) => {
  const d = new Date(today.getTime() - daysAgo * DAY_MS);
  d.setUTCHours(hh, mm, ss, 0);
  return d.toISOString();
};
const dueMs = Date.parse(utc(7, 30));

export const JOB_LOGS = [
  `// sweep-abandoned-uploads — 01:45 UTC`,
  `{"level":40,"time":"${utc(1, 45, 2)}","service":"postmind-studio","uploadIds":["upl-7f3k2"],"count":1,"msg":"abandoned uploads left in place: still referenced (check them by hand)"}`,
  `{"level":30,"time":"${utc(1, 45, 3)}","service":"postmind-studio","swept":7,"msg":"abandoned uploads swept"}`,
  ``,
  `// redrive-lost-publications — every 10 minutes`,
  `{"level":40,"time":"${utc(7, 50, 1)}","service":"postmind-studio","publicationId":"${PUBLICATIONS.ritualTiktokScheduled}","organisationId":"${DEMO_ORG_ID}","platform":"tiktok","dueAt":"${utc(7, 30)}","jobId":"publish-video__${PUBLICATIONS.ritualTiktokScheduled}__redrive__0__${dueMs}","msg":"lost publish job re-driven"}`,
  `{"level":30,"time":"${utc(7, 50, 1)}","service":"postmind-studio","considered":2,"redriven":1,"skipped":1,"msg":"lost publication sweep finished"}`,
  ``,
  `// check-platform-accounts — hourly at :20`,
  `{"level":40,"time":"${utc(1, 20, 9)}","service":"postmind-studio","connectionId":"${CONNECTIONS.x.id}","organisationId":"${DEMO_ORG_ID}","platform":"x","err":{"type":"PlatformError","message":"401 Unauthorized: token revoked"},"msg":"platform account needs reconnecting"}`,
  `{"level":40,"time":"${utc(1, 20, 13)}","service":"postmind-studio","connectionId":"${CONNECTIONS.facebook.id}","organisationId":"${DEMO_ORG_ID}","platform":"facebook","err":{"type":"PlatformError","message":"503 Service Unavailable"},"msg":"platform account check could not complete; state unchanged"}`,
  `{"level":30,"time":"${utc(1, 20, 14)}","service":"postmind-studio","checked":6,"ok":4,"needsReconnect":1,"unreachable":1,"deferred":0,"msg":"platform account check finished"}`,
].join('\n');

export const FAILOVER_RULE = `  - name: studio-providers
    rules:
      - alert: StudioProviderFailoverRateHigh
        # BACKLOG 17.4: the share of routing decisions that reached a provider and passed it over
        # (studio_provider_passed_over_total) out of all that reached it (passed over + selected,
        # studio_provider_selected_total), over 15 minutes. …
        expr: |
          (
            sum by (provider) (rate(studio_provider_passed_over_total{reason!~"provider_disabled|over_budget"}[15m]))
              /
            sum by (provider) (rate({__name__=~"studio_provider_passed_over_total|studio_provider_selected_total"}[15m]))
          ) > 0.2
          and
          sum by (provider) (increase(studio_provider_passed_over_total{reason!~"provider_disabled|over_budget"}[15m])) >= 10
        for: 10m
        labels:
          severity: ticket
        annotations:
          summary: 'High failover rate for {{ $labels.provider }}'
          runbook_url: …/runbooks/provider-outage.md#alerts

      - alert: StudioProviderCircuitOpen    # unchanged: breaker open for 5 minutes
        expr: max by (provider) (studio_provider_circuit_state) == 2
        for: 5m`;

export const BACKUP_REPORT = `Backup to studio-backup (server-side copy; deleted sources age out after 30 days)
assets (studio-assets): 48213 objects
  up to date 47904
  copied 309/309 (1184.6 MiB)
  source deleted: 212 newly, 1893 waiting out retention
  aged out and deleted 57/57
renders (studio-renders): 9120 objects
  up to date 9046
  copied 74/74 (2291.3 MiB)
  source deleted: 3 newly, 118 waiting out retention
  aged out and deleted 6/6
thumbnails (studio-thumbnails): 9120 objects
  up to date 9046
  copied 74/74 (8.9 MiB)
  source deleted: 3 newly, 118 waiting out retention
  aged out and deleted 6/6
State written. OK in 412806 ms.`;

export const BACKUP_RUN_LINE = `{"level":30,"time":"${utc(3, 36, 53)}",
 "service":"postmind-studio",
 "event":"storage_backup_run","apply":true,"ok":true,
 "durationMs":412806,
 "copied":457,"copiedBytes":3654077645,
 "expired":69,"waiting":2129,"errors":0,
 "msg":"backup: run finished"}`;
