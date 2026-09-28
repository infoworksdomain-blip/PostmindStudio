import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import {
  alertsQuery,
  buildSmokeAlerts,
  checkRouting,
  deliveryDelta,
  formatSmokeReport,
  parseNotificationCounters,
  parseSeverities,
  SMOKE_ALERTNAME,
} from './alert-smoke';

// BACKLOG 14.3 — the alert smoke test's pure logic (scripts/ops/alert-smoke.ts does the I/O).

const NOW = Date.parse('2026-09-28T10:00:00Z');

describe('parseSeverities', () => {
  it('defaults to both and accepts one', () => {
    expect(parseSeverities(undefined)).toEqual(['page', 'ticket']);
    expect(parseSeverities('ticket')).toEqual(['ticket']);
  });
  it('rejects anything else', () => {
    expect(() => parseSeverities('critical')).toThrow(ValidationError);
  });
});

describe('buildSmokeAlerts', () => {
  it('builds postableAlerts with the run id, severity label and an end time', () => {
    const [page] = buildSmokeAlerts('r1', ['page'], NOW);
    expect(page).toMatchObject({
      labels: { alertname: SMOKE_ALERTNAME, severity: 'page', smoke_run: 'r1' },
      annotations: { summary: expect.stringContaining('run r1') },
      endsAt: '2026-09-28T10:10:00.000Z',
    });
    expect(Date.parse(page?.startsAt ?? '')).toBeLessThan(NOW);
  });
  it('resolves by setting endsAt to now', () => {
    const [ticket] = buildSmokeAlerts('r1', ['ticket'], NOW, { resolved: true });
    expect(ticket?.endsAt).toBe(new Date(NOW).toISOString());
  });
});

describe('alertsQuery', () => {
  it('filters on this run with repeated filter params', () => {
    expect(alertsQuery('r1')).toBe(
      `filter=${encodeURIComponent('alertname="StudioAlertSmoke"')}&filter=${encodeURIComponent('smoke_run="r1"')}`,
    );
  });
});

describe('checkRouting', () => {
  const alert = (severity: string, receivers: string[], run = 'r1') => ({
    labels: { alertname: SMOKE_ALERTNAME, severity, smoke_run: run },
    receivers: receivers.map((name) => ({ name })),
    status: { state: 'active' },
  });
  it('passes when each severity reaches exactly its receiver', () => {
    const out = checkRouting(
      [alert('page', ['studio-page']), alert('ticket', ['studio-ticket'])],
      'r1',
      ['page', 'ticket'],
    );
    expect(out.every((r) => r.ok)).toBe(true);
  });
  it('fails on a wrong, extra or missing receiver, and ignores other runs', () => {
    const out = checkRouting(
      [alert('page', ['studio-ticket']), alert('ticket', ['studio-ticket'], 'other')],
      'r1',
      ['page', 'ticket'],
    );
    expect(out).toEqual([
      { severity: 'page', found: true, receivers: ['studio-ticket'], ok: false },
      { severity: 'ticket', found: false, receivers: [], ok: false },
    ]);
    expect(
      checkRouting([alert('page', ['studio-page', 'studio-ticket'])], 'r1', ['page'])[0]?.ok,
    ).toBe(false);
  });
});

describe('parseNotificationCounters / deliveryDelta', () => {
  const scrape = (pd: number, slack: number, pdFailed: number) => `
# HELP alertmanager_notifications_total The total number of attempted notifications.
# TYPE alertmanager_notifications_total counter
alertmanager_notifications_total{integration="pagerduty"} ${pd}
alertmanager_notifications_total{integration="slack"} ${slack}
alertmanager_notifications_total{integration="email"} 0
alertmanager_notifications_failed_total{integration="pagerduty",reason="clientError"} ${pdFailed}
alertmanager_notifications_failed_total{integration="pagerduty",reason="serverError"} 0
alertmanager_notifications_failed_total{integration="slack",reason="other"} 0
alertmanager_alerts{state="active"} 2
`;
  it('sums totals and failures per integration', () => {
    expect(parseNotificationCounters(scrape(3, 1, 1))).toMatchObject({
      pagerduty: { total: 3, failed: 1 },
      slack: { total: 1, failed: 0 },
    });
  });
  it('passes when the expected integration sent without new failures', () => {
    const out = deliveryDelta(
      parseNotificationCounters(scrape(3, 1, 1)),
      parseNotificationCounters(scrape(4, 2, 1)),
      ['page', 'ticket'],
    );
    expect(out.map((d) => d.ok)).toEqual([true, true]);
  });
  it('fails on a delivery failure (e.g. a bad PagerDuty key) or nothing sent', () => {
    const out = deliveryDelta(
      parseNotificationCounters(scrape(3, 1, 1)),
      parseNotificationCounters(scrape(4, 1, 2)),
      ['page', 'ticket'],
    );
    expect(out).toEqual([
      { severity: 'page', integration: 'pagerduty', sent: 1, failed: 1, ok: false },
      { severity: 'ticket', integration: 'slack', sent: 0, failed: 0, ok: false },
    ]);
    expect(formatSmokeReport('r1', [], out)).toContain('FAIL');
    expect(formatSmokeReport('r1', [], null)).toContain('--no-delivery');
  });
});
