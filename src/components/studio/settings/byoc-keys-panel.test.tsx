// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCredentialsResponse } from '@/lib/client/types';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { ByocKeysPanel } from './byoc-keys-panel';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => vi.unstubAllGlobals());

const providers = [
  { id: 'runway', label: 'Runway', twoPart: false },
  { id: 'storyblocks', label: 'Storyblocks', twoPart: true },
];

function enabled(
  credentials: ProviderCredentialsResponse['credentials'] = [],
): Record<string, unknown> {
  return { enabled: true, providers, credentials };
}

describe('ByocKeysPanel', () => {
  it('explains when BYOC needs the Enterprise plan', async () => {
    mockFetch(() => ok({ enabled: false, reason: 'plan_tier', providers, credentials: [] }));
    renderScreen(<ByocKeysPanel />);
    expect(await screen.findByText(/Enterprise feature/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Runway API key')).not.toBeInTheDocument();
  });

  it('explains when BYOC is switched off', async () => {
    mockFetch(() => ok({ enabled: false, reason: 'disabled', providers, credentials: [] }));
    renderScreen(<ByocKeysPanel />);
    expect(await screen.findByText(/not switched on/)).toBeInTheDocument();
  });

  it('renders nothing for members without the capability', async () => {
    const api = mockFetch(() => fail(403, 'Missing capability', 'forbidden'));
    renderScreen(<ByocKeysPanel />);
    await waitFor(() => expect(api.fn).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Provider keys (BYOC)')).not.toBeInTheDocument());
  });

  it('saves a key write-only and shows only the hint afterwards', async () => {
    let saved = false;
    const api = mockFetch((req) => {
      if (req.method === 'PUT') {
        saved = true;
        return ok({ credential: {} });
      }
      return ok(
        enabled(
          saved
            ? [
                {
                  providerId: 'runway',
                  hint: 'wxyz',
                  state: 'active',
                  lastTestedAt: null,
                  lastTestResult: null,
                  updatedAt: '2026-09-28T10:00:00.000Z',
                },
              ]
            : [],
        ),
      );
    });
    renderScreen(<ByocKeysPanel />);
    const input = await screen.findByLabelText('Runway API key');
    await userEvent.type(input, 'rw-secret-wxyz');
    await userEvent.click(
      within(screen.getByRole('listitem', { name: 'Runway' })).getByText('Save'),
    );
    await waitFor(() => expect(api.find('PUT', '/provider-credentials/runway')).toHaveLength(1));
    expect(api.find('PUT', '/provider-credentials/runway')[0]?.body).toEqual({
      apiKey: 'rw-secret-wxyz',
    });
    expect(await screen.findByText(/••••wxyz · not tested/)).toBeInTheDocument();
    expect(screen.getByLabelText('Runway API key')).toHaveValue('');
    expect(screen.queryByDisplayValue('rw-secret-wxyz')).not.toBeInTheDocument();
  });

  it('asks for both halves of a two-part key', async () => {
    const api = mockFetch((req) => (req.method === 'PUT' ? ok({}) : ok(enabled())));
    renderScreen(<ByocKeysPanel />);
    await userEvent.type(await screen.findByLabelText('Storyblocks public key'), 'public-123');
    const row = screen.getByRole('listitem', { name: 'Storyblocks' });
    expect(within(row).getByText('Save')).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Storyblocks private key'), 'private-456');
    await userEvent.click(within(row).getByText('Save'));
    await waitFor(() =>
      expect(api.find('PUT', '/provider-credentials/storyblocks')[0]?.body).toEqual({
        apiKey: 'public-123',
        secondaryKey: 'private-456',
      }),
    );
  });

  it('tests and removes an active key', async () => {
    const active = {
      providerId: 'runway',
      hint: 'wxyz',
      state: 'active' as const,
      lastTestedAt: '2026-09-28T10:00:00.000Z',
      lastTestResult: { healthy: false, reason: 'runway: unauthorized' },
      updatedAt: '2026-09-28T10:00:00.000Z',
    };
    const api = mockFetch((req) => {
      if (req.method === 'POST') return ok({ healthy: true });
      if (req.method === 'DELETE') return ok({ credential: { ...active, state: 'revoked' } });
      return ok(enabled([active]));
    });
    renderScreen(<ByocKeysPanel />);
    expect(await screen.findByText(/failed: runway: unauthorized/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() =>
      expect(api.find('POST', '/provider-credentials/runway/test')).toHaveLength(1),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.find('DELETE', '/provider-credentials/runway')).toHaveLength(1));
  });
});
