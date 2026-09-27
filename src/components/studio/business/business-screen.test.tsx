// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { BusinessScreen } from './business-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

describe('BusinessScreen', () => {
  it('asks for a business when none is selected', async () => {
    mockFetch(() => ok({}));
    renderScreen(<BusinessScreen />, null);
    expect(await screen.findByText('Pick a business first')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('switches tabs, including from the empty profile to the scan tab', async () => {
    mockFetch((req) => {
      if (req.url.pathname.endsWith('/business-profile'))
        return fail(404, 'No profile', 'not_found');
      if (req.url.pathname.endsWith('/scans')) return ok({ data: [] });
      if (req.url.pathname === '/api/studio/brand-kits') return ok({ data: [] });
      return ok({ data: [], nextCursor: null });
    });
    const user = userEvent.setup();
    renderScreen(<BusinessScreen />);
    await user.click(await screen.findByRole('button', { name: 'Scan your website' }));
    expect(screen.getByRole('tab', { name: 'Website scan' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByLabelText('Website address')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Brand kits' }));
    expect(await screen.findByText('No brand kit yet')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Image library' }));
    expect(await screen.findByText('Your image library is empty')).toBeInTheDocument();
  });
});
