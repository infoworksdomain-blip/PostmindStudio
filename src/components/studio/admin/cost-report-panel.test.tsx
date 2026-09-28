// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forbidden, mockFetch, renderWithSWR } from '../library/test-helpers';
import { CostReportPanel, rollup } from './cost-report-panel';
import type { AdminCostRow } from './types';
import { ALL_MESSAGES } from '@/lib/i18n/all-messages';
import { withLocale } from '../../../../test/i18n-wrapper';

const rows: AdminCostRow[] = [
  {
    day: '2026-09-25',
    organisationId: 'org_a',
    provider: 'runway',
    jobs: 4,
    succeeded: 3,
    failed: 1,
    costPence: 800,
  },
  {
    day: '2026-09-25',
    organisationId: 'org_b',
    provider: 'suno',
    jobs: 2,
    succeeded: 2,
    failed: 0,
    costPence: 100,
  },
  {
    day: '2026-09-26',
    organisationId: 'org_a',
    provider: 'suno',
    jobs: 4,
    succeeded: 4,
    failed: 0,
    costPence: 300,
  },
];

afterEach(() => vi.unstubAllGlobals());

describe('rollup', () => {
  it('aggregates per day, organisation and provider', () => {
    const r = rollup(rows);
    expect(r.totalPence).toBe(1200);
    expect(r.jobs).toBe(10);
    expect(r.failed).toBe(1);
    expect(r.byDay).toEqual([
      { day: '2026-09-25', costPence: 900 },
      { day: '2026-09-26', costPence: 300 },
    ]);
    expect(r.byOrg.map((o) => [o.key, o.costPence])).toEqual([
      ['org_a', 1100],
      ['org_b', 100],
    ]);
    expect(r.byProvider[0]).toEqual({ key: 'runway', costPence: 800, jobs: 4, failed: 1 });
  });
});

describe('CostReportPanel', () => {
  it('shows totals and breakdowns', async () => {
    mockFetch([{ match: '/admin/cost', body: { ok: true, days: 30, data: rows } }]);
    renderWithSWR(<CostReportPanel />);
    expect(await screen.findByText('£12.00')).toBeInTheDocument();
    expect(screen.getByText('10.0% of jobs')).toBeInTheDocument();
    const orgs = screen.getByRole('list', { name: 'Spend by organisation' });
    expect(within(orgs).getAllByRole('listitem')[0]).toHaveTextContent('org_a');
    const providers = screen.getByRole('list', { name: 'Spend by provider' });
    expect(providers).toHaveTextContent('1 failed');
  });

  it('filters by organisation and window', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([{ match: '/admin/cost', body: { ok: true, days: 30, data: [] } }]);
    renderWithSWR(<CostReportPanel />);
    expect(await screen.findByText('No provider usage in this window.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Organisation'), 'org_a');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await user.click(screen.getByRole('radio', { name: '90 days' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.url.includes('organisationId=org_a') && c.url.includes('days=90')),
      ).toBe(true),
    );
  });

  it('reports a permission error', async () => {
    mockFetch([{ match: '/admin/cost', status: 403, body: forbidden }]);
    renderWithSWR(<CostReportPanel />);
    // Both the caps panel and the report show the error.
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) expect(alert).toHaveTextContent('permission');
  });
});

describe('CostReportPanel localisation', () => {
  it('renders Arabic right-to-left', async () => {
    mockFetch([{ match: '/admin/cost', body: { ok: true, days: 30, data: rows } }]);
    renderWithSWR(withLocale('ar', <CostReportPanel />));
    const ar = ALL_MESSAGES.ar.admin.cost.report;
    expect(await screen.findByRole('list', { name: ar.byProviderAria })).toBeInTheDocument();
    expect(screen.getByText(ar.spend)).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute('dir', 'rtl'));
  });

  it('renders Simplified Chinese', async () => {
    mockFetch([{ match: '/admin/cost', body: { ok: true, days: 30, data: rows } }]);
    renderWithSWR(withLocale('zh-Hans', <CostReportPanel />));
    expect(await screen.findByText('服务商支出')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '90 天' })).toBeInTheDocument();
  });
});
