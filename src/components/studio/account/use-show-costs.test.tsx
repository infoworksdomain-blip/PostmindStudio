// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../review/test-helpers';
import { isCostViewer, useShowCosts } from './use-show-costs';

afterEach(() => vi.unstubAllGlobals());

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

function meAs(platformRole: string) {
  return mockFetch([
    { match: '/me', body: { ok: true, me: { capabilities: [], user: { platformRole } } } },
  ]);
}

describe('isCostViewer', () => {
  it('is true only for platform staff and superadmins', () => {
    expect(isCostViewer('staff')).toBe(true);
    expect(isCostViewer('superadmin')).toBe(true);
    expect(isCostViewer('user')).toBe(false);
    expect(isCostViewer('admin')).toBe(false);
    expect(isCostViewer('')).toBe(false);
    expect(isCostViewer(null)).toBe(false);
    expect(isCostViewer(undefined)).toBe(false);
  });
});

describe('useShowCosts', () => {
  it.each(['staff', 'superadmin'])('shows costs to %s', async (role) => {
    meAs(role);
    const { result } = renderHook(() => useShowCosts(), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('hides costs from customers', async () => {
    const api = meAs('user');
    const { result } = renderHook(() => useShowCosts(), { wrapper });
    await waitFor(() => expect(api.find('GET', '/me')).toHaveLength(1));
    expect(result.current).toBe(false);
  });

  it('hides costs while /me is loading or when it fails', async () => {
    const api = mockFetch([]);
    const { result } = renderHook(() => useShowCosts(), { wrapper });
    expect(result.current).toBe(false);
    await waitFor(() => expect(api.find('GET', '/me').length).toBeGreaterThan(0));
    expect(result.current).toBe(false);
  });
});
