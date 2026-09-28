// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { ReviewScreen } from './review-screen';
import { makeProject, mockFetch, renderWithSWR, type MockRoute } from './test-helpers';
import type { ProjectDetail } from '@/lib/client/types';

// BACKLOG 16.4 — the Review screen (and its Overlays tab) in Arabic (RTL) and Simplified Chinese.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function routes(project: ProjectDetail): MockRoute[] {
  return [
    { match: `/projects/${project.id}`, body: { ok: true, project } },
    {
      match: /\/renders\/[^/]+\/preview$/,
      body: { ok: true, url: 'https://cdn.test/render.mp4', expiresInSec: 3600 },
    },
    { match: '/platform-connections', body: { ok: true, data: [] } },
    { match: '/overlay-presets', body: { ok: true, data: [] } },
    { match: /\/overlays$/, body: { ok: true, data: [] } },
  ];
}

afterEach(() => vi.unstubAllGlobals());

describe('ReviewScreen in other locales', () => {
  it('renders right to left in Arabic, with Arabic labels', async () => {
    mockFetch(routes(makeProject()));
    renderWithSWR(withLocale('ar', <ReviewScreen projectId="proj_1" />));
    expect(await screen.findByRole('heading', { name: 'Spring menu launch' })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(document.documentElement).toHaveAttribute('lang', 'ar');
    expect(screen.getByText('جاهز للمراجعة')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'تقدّم مراحل الإنتاج' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'موافقة' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'نسخة TikTok' })).toBeInTheDocument();
    // RTL tab bar: ArrowLeft moves to the next tab (Variants → Shots).
    const tabs = screen.getByRole('tablist');
    within(tabs).getByRole('tab', { name: 'النسخ' }).focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(within(tabs).getByRole('tab', { name: 'اللقطات' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('renders in Simplified Chinese, including the overlay editor', async () => {
    mockFetch(routes(makeProject()));
    renderWithSWR(withLocale('zh-Hans', <ReviewScreen projectId="proj_1" />));
    expect(await screen.findByRole('heading', { name: 'Spring menu launch' })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(screen.getByText('待审核')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '批准' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: '叠加层' }));
    expect(await screen.findByRole('heading', { name: '整个视频' })).toBeInTheDocument();
  });
});
