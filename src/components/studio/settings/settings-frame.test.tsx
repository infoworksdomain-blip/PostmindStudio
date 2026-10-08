// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { SettingsFrame } from './settings-frame';

const nav = vi.hoisted(() => ({ pathname: '/settings/members' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

function navs() {
  return screen.getAllByRole('navigation', { name: 'Settings sections' });
}

describe('SettingsFrame (25.12)', () => {
  it('lists the settings pages in groups and marks the current one', () => {
    nav.pathname = '/settings/members';
    render(withLocale('en-GB', <SettingsFrame>page</SettingsFrame>));
    const [side, strip] = navs();
    for (const list of [side!, strip!]) {
      const current = within(list).getByRole('link', { current: 'page' });
      expect(current).toHaveTextContent('Members');
      expect(current).toHaveAttribute('href', '/settings/members');
    }
    for (const group of ['Account', 'Workspace', 'Publishing', 'Billing'])
      expect(within(side!).getByText(group)).toBeInTheDocument();
    expect(within(side!).getByRole('link', { name: 'Provider keys' })).toHaveAttribute(
      'href',
      '/settings/provider-keys',
    );
    expect(within(side!).getByRole('link', { name: 'Appearance' })).toHaveAttribute(
      'href',
      '/account/profile#appearance',
    );
    expect(screen.getByText('page')).toBeInTheDocument();
  });

  it('marks Appearance while its anchor is in the URL', () => {
    nav.pathname = '/account/profile';
    window.location.hash = '#appearance';
    render(withLocale('en-GB', <SettingsFrame>page</SettingsFrame>));
    const [side] = navs();
    expect(within(side!).getByRole('link', { current: 'page' })).toHaveTextContent('Appearance');
    window.location.hash = '';
  });

  it('renders in Arabic', () => {
    nav.pathname = '/connections';
    render(withLocale('ar', <SettingsFrame>page</SettingsFrame>));
    expect(screen.getAllByRole('link', { current: 'page' })[0]).toHaveTextContent(
      'الحسابات الاجتماعية',
    );
  });
});
