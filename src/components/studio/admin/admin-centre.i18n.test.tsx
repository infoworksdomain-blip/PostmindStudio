// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { mockFetch, renderWithSWR } from '../library/test-helpers';
import { AdminCentre } from './admin-centre';
import type { KillSwitchState } from './types';

// BACKLOG 16.4 — the Admin Centre header, section menu (25.13) and kill-switch panel render from the catalogue in
// Arabic (right-to-left, Arabic plurals) and Simplified Chinese.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin',
  useSearchParams: () => new URLSearchParams(),
}));

const running: KillSwitchState = {
  ok: true,
  global: { enabled: false, since: null },
  frozenWorkspaces: [{ id: 'org_frozen', since: '2026-09-26T10:00:00.000Z' }],
  killedProjects: [],
  disabledProviders: [
    { id: 'runway', since: '2026-09-25T10:00:00.000Z' },
    { id: 'luma', since: '2026-09-25T11:00:00.000Z' },
  ],
  disabledPlatforms: [],
  propagationSec: 30,
  singleApprover: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('AdminCentre localisation', () => {
  it('renders Arabic right-to-left', async () => {
    mockFetch([{ match: '/admin/kill-switch', body: running }]);
    renderWithSWR(withLocale('ar', <AdminCentre />));
    expect(await screen.findByRole('heading', { name: 'Studio يعمل' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'مركز الإدارة' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'مفتاح الإيقاف الطارئ' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'إعادة التشغيل' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تفعيل مفتاح الإيقاف العام' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إلغاء runway' })).toBeInTheDocument();
    // Arabic dual for two disabled providers, zero form for no killed projects.
    expect(screen.getByText('اثنان نشطان')).toBeInTheDocument();
    expect(screen.getAllByText('لا شيء نشط')).toHaveLength(2);
    const form = screen.getByRole('form', { name: 'تفعيل مفتاح إيقاف طارئ محدد النطاق' });
    expect(within(form).getByLabelText('المستوى')).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(document.documentElement).toHaveAttribute('lang', 'ar');
  });

  it('renders Simplified Chinese', async () => {
    mockFetch([{ match: '/admin/kill-switch', body: running }]);
    renderWithSWR(withLocale('zh-Hans', <AdminCentre />));
    expect(await screen.findByRole('heading', { name: 'Studio 正在运行' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '管理中心' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '紧急停止' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '功能' })).toBeInTheDocument();
    expect(screen.getByText('没有终止的项目。')).toBeInTheDocument();
    expect(screen.getByText('启用需要两人：另一名员工需在 10 分钟内确认。')).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
  });
});
