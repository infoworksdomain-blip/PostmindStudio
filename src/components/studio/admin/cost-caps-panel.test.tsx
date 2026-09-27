// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forbidden, mockFetch, renderWithSWR } from '../library/test-helpers';
import { CostCapsPanel, type CostCapsResponse } from './cost-caps-panel';

const body: CostCapsResponse = {
  ok: true,
  day: '2026-09-27',
  caps: {
    globalDaily: { capPence: 100_000, spentPence: 85_000, percent: 85 },
    orgDailyByTier: { BASIC: 500, STANDARD: 2_000, PLUS: null, ENTERPRISE: null },
    orgProviderDaily: null,
    projectPausePercent: 90,
  },
  organisations: [
    { organisationId: 'org_a', spentPence: 1_900, providers: [] },
    { organisationId: 'org_b', spentPence: 100, providers: [] },
  ],
  projects: [
    {
      id: 'p1',
      organisationId: 'org_a',
      name: 'Autumn launch',
      state: 'FAILED',
      costBudgetPence: 1_000,
      costActualPence: 950,
      percent: 95,
      paused: true,
    },
  ],
  recentAlerts: [
    {
      id: 'a1',
      scope: 'GLOBAL_DAILY',
      scopeId: 'global',
      organisationId: null,
      period: '2026-09-27',
      threshold: 80,
      capPence: 100_000,
      spentPence: 80_100,
      createdAt: new Date().toISOString(),
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('CostCapsPanel', () => {
  it('shows spend against each cap, paused projects and recent alerts', async () => {
    mockFetch([{ match: '/admin/cost/caps', body }]);
    renderWithSWR(<CostCapsPanel />);
    expect(await screen.findByText('Caps today (2026-09-27, UTC)')).toBeInTheDocument();
    expect(screen.getByText('£850.00 / £1,000.00')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Global daily cap used' })).toHaveAttribute(
      'aria-valuenow',
      '85',
    );
    expect(screen.getByText(/basic £5.00 · standard £20.00 · plus No cap/)).toBeInTheDocument();
    const projects = screen.getByRole('list', { name: 'Projects near their budget' });
    expect(within(projects).getByRole('link', { name: 'Autumn launch' })).toHaveAttribute(
      'href',
      '/projects/p1',
    );
    expect(projects).toHaveTextContent('95% · paused');
    const alerts = screen.getByRole('list', { name: 'Recent cost alerts' });
    expect(alerts).toHaveTextContent('80% Global daily');
    expect(
      within(screen.getByRole('list', { name: 'Organisation spend today' })).getAllByRole(
        'listitem',
      )[0],
    ).toHaveTextContent('org_a');
  });

  it('has honest empty states', async () => {
    mockFetch([
      {
        match: '/admin/cost/caps',
        body: {
          ...body,
          caps: { ...body.caps, globalDaily: { capPence: null, spentPence: 0, percent: null } },
          organisations: [],
          projects: [],
          recentAlerts: [],
        },
      },
    ]);
    renderWithSWR(<CostCapsPanel />);
    expect(await screen.findByText('No cost alerts.')).toBeInTheDocument();
    expect(screen.getByText('No provider spend today.')).toBeInTheDocument();
    expect(screen.getByText('£0.00 / No cap')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('reports errors', async () => {
    mockFetch([{ match: '/admin/cost/caps', status: 403, body: forbidden }]);
    renderWithSWR(<CostCapsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('permission');
  });
});
