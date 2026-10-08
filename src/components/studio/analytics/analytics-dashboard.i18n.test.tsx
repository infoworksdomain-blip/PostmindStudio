// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { ALL_MESSAGES } from '@/lib/i18n/all-messages';
import { mockFetch } from '../library/test-helpers';
import { AnalyticsDashboard } from './analytics-dashboard';
import { me, renderPage, routes } from './analytics-test-fixtures';

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace }),
  usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(nav.search),
}));

beforeEach(() => {
  nav.search = '';
  nav.replace.mockReset();
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('AnalyticsDashboard for customers (operator decision 2026-10-04)', () => {
  it('shows no spend figure, spend section or cost wording, and never asks for costs', async () => {
    const { calls } = mockFetch(routes([me('user')]));
    renderPage();
    await screen.findByRole('region', { name: 'Summary' });
    await screen.findByRole('list', { name: 'Views by platform' });
    expect(screen.queryByText('Spend')).not.toBeInTheDocument();
    expect(screen.queryByText(/£/)).not.toBeInTheDocument();
    expect(screen.queryByText(/cost/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Spend by provider' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/analytics/cost'))).toBe(false);
  });
});

describe('AnalyticsDashboard localisation', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('dir');
    document.documentElement.removeAttribute('lang');
  });

  it('renders Arabic right-to-left, with Arabic plurals and RTL arrow keys', async () => {
    const user = userEvent.setup();
    // jsdom has no UA stylesheet, so `dir="rtl"` does not set the computed direction the shared
    // SegmentedControl reads (ui/roving); give the document the browser's rule for the test.
    const ua = document.createElement('style');
    ua.textContent = '[dir="rtl"], [dir="rtl"] * { direction: rtl; }';
    document.head.append(ua);
    const ar = ALL_MESSAGES.ar.analytics;
    const { calls } = mockFetch(routes());
    renderPage(withLocale('ar', <AnalyticsDashboard />));
    expect(
      await screen.findByRole('heading', { name: ar.dashboard.title, level: 1 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute('dir', 'rtl'));
    // 7 → the Arabic "few" form; 30 → "many".
    expect(screen.getByRole('radio', { name: '7 أيام' })).toBeInTheDocument();
    const thirty = screen.getByRole('radio', { name: '30 يومًا' });
    expect(thirty).toHaveAttribute('aria-checked', 'true');
    expect(await screen.findByRole('list', { name: ar.platforms.listLabel })).toBeInTheDocument();
    expect(
      await screen.findByRole('list', { name: ar.cost.byProvider.listLabel }),
    ).toHaveTextContent('4 مهام');
    // In RTL the next option sits to the left.
    thirty.focus();
    await user.keyboard('{ArrowLeft}');
    await waitFor(() =>
      expect(
        calls.some((c) => c.url.includes('/analytics/cost') && c.url.includes('days=90')),
      ).toBe(true),
    );
    ua.remove();
  });

  it('renders Simplified Chinese', async () => {
    const zh = ALL_MESSAGES['zh-Hans'].analytics;
    mockFetch(routes());
    renderPage(withLocale('zh-Hans', <AnalyticsDashboard />));
    expect(
      await screen.findByRole('heading', { name: zh.dashboard.title, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '7 天' })).toBeInTheDocument();
    expect(await screen.findByText('3 条帖子 · 新建 2 个项目')).toBeInTheDocument();
    expect(screen.getByText(zh.dashboard.scopeAll)).toBeInTheDocument();
    expect(
      await screen.findByRole('list', { name: zh.cost.byProvider.listLabel }),
    ).toHaveTextContent('4 个任务');
    await waitFor(() => expect(document.documentElement).toHaveAttribute('lang', 'zh-Hans'));
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
  });
});
