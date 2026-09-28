// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR } from './library/test-helpers';
import { UsagePanel } from './admin/usage-panel';
import { UsageBanner, type UsageResponse } from './usage-meter';

const usage = (
  short: number,
  patch: Partial<UsageResponse['usage']> = {},
): UsageResponse['usage'] => ({
  organisationId: 'org_1',
  planTier: 'BASIC',
  mode: 'warn',
  month: '2026-09',
  periodStart: '2026-09-01T00:00:00.000Z',
  resetsAt: '2026-10-01T00:00:00.000Z',
  thresholds: [80, 100],
  status: short >= 20 ? 'exceeded' : short >= 16 ? 'warning' : 'ok',
  videos: {
    short: { used: short, limit: 20, percent: Math.round((short / 20) * 100), maxDurationSec: 30 },
    long: { used: 0, limit: 0, percent: 0, maxDurationSec: 0 },
  },
  platforms: { rule: 'tiktok_instagram_plus_one', description: 'TikTok + Instagram + 1 more' },
  scans: { businessesScanned: 1, limit: 1 },
  ...patch,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UsageBanner (decision P3)', () => {
  it('renders nothing below 80 %', async () => {
    const api = mockFetch([{ match: '/usage', body: { ok: true, usage: usage(10) } }]);
    const { container } = renderWithSWR(<UsageBanner />);
    await vi.waitFor(() => expect(api.fn).toHaveBeenCalled());
    expect(container.querySelector('[aria-label="Plan usage"]')).toBeNull();
  });

  it('warns at 80 % with a meter and an upgrade prompt', async () => {
    mockFetch([{ match: '/usage', body: { ok: true, usage: usage(17) } }]);
    renderWithSWR(<UsageBanner />);
    expect(await screen.findByText(/close to this month’s Basic plan limit/)).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Short videos' })).toHaveAttribute(
      'aria-valuenow',
      '17',
    );
    expect(screen.queryByRole('meter', { name: 'Long videos' })).toBeNull();
  });

  it('says new videos are paused when exceeded in enforce mode', async () => {
    mockFetch([{ match: '/usage', body: { ok: true, usage: usage(20, { mode: 'enforce' }) } }]);
    renderWithSWR(<UsageBanner />);
    expect(await screen.findByText(/New videos are paused until 1 Oct/)).toBeInTheDocument();
  });
});

describe('UsagePanel (admin)', () => {
  it('looks an organisation up, optionally against another tier', async () => {
    const user = userEvent.setup();
    const api = mockFetch([
      {
        match: /\/admin\/organisations\/org_7\/usage/,
        body: {
          ok: true,
          usage: { ...usage(5), tier: { value: 'BASIC', source: 'last_generation' } },
        },
      },
    ]);
    renderWithSWR(<UsagePanel />);
    await user.type(screen.getByLabelText('Organisation id'), 'org_7');
    await user.selectOptions(screen.getByLabelText('Evaluate against'), 'PLUS');
    await user.click(screen.getByRole('button', { name: 'Show usage' }));
    expect(await screen.findByText(/recorded on its latest generation/)).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: /Short videos/ })).toBeInTheDocument();
    expect(api.calls.at(-1)?.url).toContain('tier=PLUS');
  });
});
