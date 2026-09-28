// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR } from '../library/test-helpers';
import { FeaturesPanel, type FeaturesResponse } from './features-panel';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const state = (patch: Partial<FeaturesResponse['features']> = {}): FeaturesResponse =>
  ({
    ok: true,
    propagationSec: 30,
    features: {
      library: { global: true, environment: true, disabledFor: [] },
      overlays: { global: true, environment: true, disabledFor: [] },
      slideshow: { global: true, environment: true, disabledFor: ['org_9'] },
      'image-library': { global: true, environment: false, disabledFor: [] },
      ...patch,
    },
  }) as FeaturesResponse;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('FeaturesPanel (15.D1)', () => {
  it('shows each feature, env-off state and per-org overrides', async () => {
    mockFetch([{ match: '/admin/features', body: state() }]);
    renderWithSWR(<FeaturesPanel />);
    await screen.findByRole('list', { name: 'Slideshows disabled for' });
    expect(screen.getByText('Off by environment (FEATURE_*_ENABLED)')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Slideshows disabled for' });
    expect(within(list).getByText('org_9')).toBeInTheDocument();
  });

  it('turning a feature off globally needs a reason and the typed feature name', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/admin/features', body: state() },
      {
        match: '/admin/features',
        method: 'PUT',
        body: state({ overlays: { global: false, environment: true, disabledFor: [] } }),
      },
    ]);
    renderWithSWR(<FeaturesPanel />);
    await screen.findByRole('list', { name: 'Slideshows disabled for' });
    const buttons = screen.getAllByRole('button', { name: 'Turn off globally' });
    await user.click(buttons[1] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Turn off' });
    await user.type(within(dialog).getByLabelText(/Reason/), 'provider outage');
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), 'overlays');
    await user.click(confirm);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({
      feature: 'overlays',
      scope: 'global',
      enabled: false,
      reason: 'provider outage',
    });
    expect(await screen.findByText('Turn on globally')).toBeInTheDocument();
  });

  it('disables for one organisation and re-enables an override', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/admin/features', body: state() },
      { match: '/admin/features', method: 'PUT', body: state() },
    ]);
    renderWithSWR(<FeaturesPanel />);
    await screen.findByRole('list', { name: 'Slideshows disabled for' });
    await user.selectOptions(screen.getByLabelText('Feature'), 'library');
    await user.type(screen.getByLabelText('Organisation id'), 'org_1');
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    let dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'licence review');
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(calls.filter((c) => c.method === 'PUT')[0]?.body).toMatchObject({
      feature: 'library',
      scope: 'organisation',
      organisationId: 'org_1',
      enabled: false,
    });
    await user.click(screen.getByRole('button', { name: 'Turn back on' }));
    dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'resolved');
    await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(calls.filter((c) => c.method === 'PUT')[1]?.body).toMatchObject({
      feature: 'slideshow',
      organisationId: 'org_9',
      enabled: true,
    });
  });
});
