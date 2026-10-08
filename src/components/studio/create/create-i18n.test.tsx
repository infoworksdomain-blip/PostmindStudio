// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { mockFetch, renderWithSWR } from '../review/test-helpers';
import { CreateScreen } from './create-screen';

// BACKLOG 16.4 — the Create screen in Arabic (RTL) and Simplified Chinese.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/new',
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const routes = [
  { match: '/brand-kits', body: { ok: true, data: [] } },
  { match: '/platform-connections', body: { ok: true, data: [] } },
  { match: '/templates', body: { ok: true, data: [] } },
];

afterEach(() => vi.unstubAllGlobals());

describe('CreateScreen in other locales', () => {
  it('asks the question and validates in Arabic, right to left', async () => {
    mockFetch(routes);
    renderWithSWR(withLocale('ar', <CreateScreen initialReference={null} />));
    expect(await screen.findByLabelText('عمّ يتحدث الفيديو؟')).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    await userEvent.click(screen.getByRole('button', { name: 'إنشاء' }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).not.toMatch(/[A-Za-z]{4,}/);
  });

  it('asks the question in Simplified Chinese', async () => {
    mockFetch(routes);
    renderWithSWR(withLocale('zh-Hans', <CreateScreen initialReference={null} />));
    expect(await screen.findByLabelText('视频的主题是什么？')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '更多选项' }));
    expect(screen.getByRole('radio', { name: '幻灯片' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '平台和时长' })).toBeInTheDocument();
  });
});
