// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, ok, renderScreen } from '../publications/test-utils';
import { ProviderKeysScreen } from './provider-keys-screen';

afterEach(() => vi.unstubAllGlobals());

const me = (capabilities: string[]) => ok({ me: { capabilities, user: { platformRole: 'user' } } });

describe('ProviderKeysScreen (25.12)', () => {
  it('lists the provider keys on their own settings page', async () => {
    mockFetch((req) =>
      req.url.pathname === '/api/studio/me'
        ? me(['studio:connections:manage'])
        : ok({ enabled: true, providers: [{ id: 'runway', label: 'Runway' }], credentials: [] }),
    );
    renderScreen(<ProviderKeysScreen />);
    expect(screen.getByRole('heading', { name: 'Provider keys', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Runway')).toBeInTheDocument();
  });

  it('tells members without the capability who manages them, and asks for nothing', async () => {
    const api = mockFetch((req) =>
      req.url.pathname === '/api/studio/me' ? me(['studio:project:read']) : ok({}),
    );
    renderScreen(<ProviderKeysScreen />);
    expect(await screen.findByRole('note')).toHaveTextContent(/Only owners and admins/);
    await waitFor(() => expect(api.find('GET', '/me')).toHaveLength(1));
    expect(api.find('GET', '/provider-credentials')).toHaveLength(0);
  });
});
