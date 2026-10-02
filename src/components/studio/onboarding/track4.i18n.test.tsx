// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { ExportScreen } from '../account/export-screen';
import { fail, mockFetch as rawMockFetch, ok, renderScreen } from '../publications/test-utils';
import { ByocKeysPanel } from '../settings/byoc-keys-panel';
import { PublicPreview } from '../share/public-preview';
import { ShareLinksPanel } from '../share/share-links-panel';
import { TemplatesScreen } from '../templates/templates-screen';
import { WelcomeWizard } from './welcome-wizard';

// BACKLOG 16.3 / 16.4 — Track 4 screens (onboarding, share, templates, account) render from the
// Arabic (RTL, six plural categories) and Simplified Chinese catalogues. Missing keys throw.

/** ByocKeysPanel asks for provider keys only once /me says the member may manage connections. */
const mockFetch: typeof rawMockFetch = (handler) =>
  rawMockFetch((req) =>
    req.url.pathname === '/api/studio/me'
      ? ok({ me: { capabilities: ['studio:connections:manage'], user: { platformRole: 'user' } } })
      : handler(req),
  );

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const onboarding = {
  step: 'connect',
  completed: [],
  firstVideoProjectId: null,
  dismissedAt: null,
  startedAt: null,
  suggested: true,
};

function mockWizard() {
  mockFetch((req) =>
    req.url.pathname.endsWith('/onboarding') ? ok({ onboarding }) : ok({ data: [] }),
  );
}

describe('WelcomeWizard localised', () => {
  it('renders in Arabic, right-to-left', async () => {
    mockWizard();
    renderScreen(withLocale('ar', <WelcomeWizard />));
    expect(
      await screen.findByRole('heading', { name: 'اربط المنصات التي تنشر عليها' }),
    ).toBeVisible();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    const steps = screen.getByRole('list', { name: 'تقدّم الإعداد' });
    expect(within(steps).getByText('هوية العلامة')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تخطي هذه الخطوة' })).toBeEnabled();
    expect(await screen.findByText('لا توجد حسابات مرتبطة بعد.')).toBeVisible();
  });

  it('renders in Simplified Chinese', async () => {
    mockWizard();
    renderScreen(withLocale('zh-Hans', <WelcomeWizard />));
    expect(await screen.findByRole('heading', { name: '连接你的发布渠道' })).toBeVisible();
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(screen.getByRole('button', { name: '跳过设置' })).toBeInTheDocument();
  });
});

describe('ShareLinksPanel localised', () => {
  const links = [
    {
      id: 'sl_1',
      state: 'active',
      expiresAt: '2026-10-04T00:00:00.000Z',
      createdAt: '2026-10-01T00:00:00.000Z',
      viewCount: 2,
      comments: [],
    },
  ];
  it('uses Arabic plural categories for views and expiry options', async () => {
    mockFetch(() => ok({ data: links }));
    renderScreen(withLocale('ar', <ShareLinksPanel projectId="prj_1" />));
    expect(await screen.findByText(/مشاهدتان/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'يوم واحد' })).toBeInTheDocument();
    expect(screen.getByText('نشط')).toBeInTheDocument();
  });
  it('renders in Simplified Chinese', async () => {
    mockFetch(() => ok({ data: links }));
    renderScreen(withLocale('zh-Hans', <ShareLinksPanel projectId="prj_1" />));
    expect(await screen.findByText(/2 次观看/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /创建链接/ })).toBeInTheDocument();
  });
});

describe('PublicPreview localised (viewer’s locale)', () => {
  const preview = {
    ok: true,
    project: { name: 'Spring menu', state: 'READY_FOR_REVIEW' },
    variants: [
      {
        id: 'r1',
        platform: 'tiktok',
        aspectRatio: '9:16',
        durationSec: 15,
        videoUrl: 'https://cdn.test/r1.mp4',
      },
    ],
    comments: [],
    expiresAt: '2026-10-04T00:00:00.000Z',
    canApprove: false,
  };
  it('renders the page chrome in Arabic and leaves the project name untouched', async () => {
    mockFetch(() => ({ body: preview }));
    renderScreen(withLocale('ar', <PublicPreview token="tok" />));
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Spring menu');
    expect(screen.getByRole('heading', { name: 'اترك ملاحظاتك' })).toBeInTheDocument();
    expect(screen.getByLabelText('اسمك')).toBeInTheDocument();
    expect(screen.getByText('لا توجد ملاحظات بعد.')).toBeInTheDocument();
  });
  it('shows the dead-link page in Simplified Chinese', async () => {
    mockFetch(() => fail(404, 'This preview link is invalid or has expired', 'not_found'));
    renderScreen(withLocale('zh-Hans', <PublicPreview token="dead" />));
    expect(await screen.findByText('预览不可用')).toBeInTheDocument();
    expect(screen.getByText('此预览链接无效或已过期')).toBeInTheDocument();
  });
});

describe('TemplatesScreen localised', () => {
  const rows = [
    {
      id: 'st_1',
      name: 'My listicle',
      category: 'photo_dump',
      organisationId: 'org',
      createdAt: '2026-10-01T00:00:00Z',
    },
  ];
  it('renders in Arabic with a localised category and delete label', async () => {
    mockFetch((req) =>
      req.url.pathname.endsWith('/slideshow-templates') ? ok({ data: rows }) : ok({ data: [] }),
    );
    renderScreen(withLocale('ar', <TemplatesScreen />));
    expect(await screen.findByRole('button', { name: 'حذف My listicle' })).toBeInTheDocument();
    expect(screen.getByText(/مجموعة صور/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'القوالب' })).toBeInTheDocument();
  });
  it('renders in Simplified Chinese', async () => {
    mockFetch(() => ok({ data: [] }));
    renderScreen(withLocale('zh-Hans', <TemplatesScreen />));
    expect(await screen.findByText('没有内置模板')).toBeInTheDocument();
  });
});

describe('ExportScreen localised', () => {
  it('renders in Arabic and Simplified Chinese', async () => {
    mockFetch(() => ok({ data: [] }));
    const { unmount } = renderScreen(withLocale('ar', <ExportScreen />));
    expect(await screen.findByText('لا توجد عمليات تصدير بعد')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'مكتبة الصور' })).toBeInTheDocument();
    unmount();
    renderScreen(withLocale('zh-Hans', <ExportScreen />));
    expect(await screen.findByRole('button', { name: /申请导出/ })).toBeInTheDocument();
  });
});

describe('ByocKeysPanel localised', () => {
  it('explains the Enterprise gate in Arabic and Simplified Chinese', async () => {
    mockFetch(() => ok({ enabled: false, reason: 'plan_tier', providers: [], credentials: [] }));
    const { unmount } = renderScreen(withLocale('ar', <ByocKeysPanel />));
    expect(await screen.findByText(/باقة Enterprise/)).toBeInTheDocument();
    unmount();
    renderScreen(withLocale('zh-Hans', <ByocKeysPanel />));
    expect(await screen.findByText(/是 Enterprise 功能/)).toBeInTheDocument();
  });
});
