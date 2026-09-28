// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { IntlTestProvider } from '../../../test/i18n-wrapper';
import type { Locale } from '@/lib/i18n/locales';
import { useNotificationText, type LocalisableNotification } from './notification-text';

// BACKLOG 16.5 — keyed notifications render in the reader's locale; old rows keep stored text.

const render = (locale: Locale, n: LocalisableNotification) =>
  renderHook(() => useNotificationText(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <IntlTestProvider locale={locale}>{children}</IntlTestProvider>
    ),
  }).result.current(n);

const stored = { title: 'Stored title', body: 'Stored body' };

describe('useNotificationText', () => {
  it('renders a keyed notification from the catalogue', () => {
    const n = { ...stored, messageKey: 'approvalPending', messageParams: { name: 'Launch' } };
    expect(render('en-GB', n)).toEqual({
      title: '“Launch” is waiting for approval',
      body: 'It has been ready for review for more than 2 hours.',
    });
    const fr = render('fr', n);
    expect(fr.title).toContain('Launch');
    expect(fr.title).not.toBe('“Launch” is waiting for approval');
  });

  it('shows the platform id as its label', () => {
    const n = {
      ...stored,
      messageKey: 'publicationFailed',
      messageParams: { name: 'Launch', platform: 'youtube_short', reason: 'Token expired' },
    };
    expect(render('en-GB', n).title).toBe('Publishing “Launch” to YouTube Shorts failed');
  });

  it('formats number parameters in the locale', () => {
    const n = {
      ...stored,
      messageKey: 'milestoneViews',
      messageParams: { name: 'Launch', platform: 'tiktok', threshold: 10000, count: 12345 },
    };
    expect(render('en-GB', n).body).toContain('12,345');
    expect(render('de', n).body).toContain('12.345');
  });

  it('falls back to the stored text without a key, with an unknown key or missing params', () => {
    expect(render('fr', stored)).toEqual(stored);
    expect(render('fr', { ...stored, messageKey: 'fromTheFuture' })).toEqual(stored);
    expect(render('en-GB', { ...stored, messageKey: 'approvalPending' })).toEqual(stored);
  });
});
