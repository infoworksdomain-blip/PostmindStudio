// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { FailureReason } from '../failure-reason';
import { QualityPanel } from './quality-panel';
import { makeRender, mockFetch, renderWithSWR } from './test-helpers';
import type { QualityIssue } from '@/lib/client/types';

// BACKLOG 17.9 — server-originated text in the reader's language: failure reasons (stored as
// `<code>: <detail>`) and quality-check details (stored with detailKey + detailParams), in
// Arabic (RTL, six plural forms) and Simplified Chinese, with the stored English as the fallback.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const reason = (locale: 'ar' | 'zh-Hans' | 'en-GB', text: string) =>
  render(withLocale(locale, <FailureReason reason={text} />)).container.textContent ?? '';

describe('FailureReason', () => {
  it('translates coded reasons in Arabic and keeps outside text untranslated', () => {
    expect(reason('ar', 'script_safety_block: Mentions a competitor')).toBe(
      'أوقف فحص سلامة النص هذا الفيديو. Mentions a competitor',
    );
    expect(reason('ar', 'planning_failed: kill_switch_workspace: Studio kill switch active')).toBe(
      'فشل تخطيط الفيديو. متوقف مؤقتًا: أوقفت PostMind الإنشاء لمؤسستك.',
    );
    // Two shots: the Arabic dual form.
    expect(
      reason('ar', 'asset_generation_failed: shot 2: runway/timeout: x; shot 4: luma/unknown: y'),
    ).toMatch(/^تعذّر إنشاء اللقطتين /);
    expect(reason('ar', 'cancelled_by_user')).toBe('ألغيت هذا التشغيل.');
  });

  it('translates coded reasons in Simplified Chinese', () => {
    // 20.11: the provider's own text is not shown (it can be a raw JSON body).
    expect(reason('zh-Hans', 'composition_failed: shotstack/rate_limited: Too Many Requests')).toBe(
      '视频合成失败。 Shotstack 报告了问题：请求过多。',
    );
    expect(reason('zh-Hans', 'scan_cost_cap: Stopped at the scan cost cap (50p)')).toMatch(
      /^扫描已在费用上限（.*0\.50.*）处停止。$/,
    );
    expect(
      reason(
        'zh-Hans',
        "The site's robots.txt does not allow PostMindStudio to fetch the homepage",
      ),
    ).toBe('该网站的 robots.txt 不允许 Studio 读取其首页。');
    expect(
      reason(
        'zh-Hans',
        'quality_failed: tiktok/audio_present: no audio stream; tiktok/codec: vp9 (x) in webm',
      ),
    ).toBe('2 项质量检查未通过：TikTok – 音频存在和TikTok – 编码格式。');
  });

  it('20.11: account problems read as a friendly unavailable sentence in every locale', () => {
    expect(reason('en-GB', 'service_unavailable: anthropic/account_limit')).toBe(
      'Our AI service is temporarily unavailable, so this could not be finished. Please try again later — our team has been alerted.',
    );
    expect(
      reason('ar', 'planning_failed: service_unavailable: Every text_generation provider'),
    ).toBe(
      'فشل تخطيط الفيديو. خدمة الذكاء الاصطناعي لدينا غير متاحة مؤقتًا، لذا تعذّر إكمال هذا. يُرجى المحاولة لاحقًا، فقد تم إبلاغ فريقنا.',
    );
    // Rows stored before 20.11 as <provider>/<account class>: <provider text>.
    expect(
      reason('zh-Hans', 'openai/insufficient_credits: 429 You have no credits remaining.'),
    ).toBe('我们的 AI 服务暂时不可用，因此未能完成。请稍后再试——我们的团队已收到通知。');
    // A social platform's reason is still shown.
    expect(reason('en-GB', 'tiktok/content_policy: Video violates community guidelines')).toContain(
      'Video violates community guidelines',
    );
  });

  it('falls back to the stored text for reasons without a known code', () => {
    expect(reason('ar', 'Export bucket missing')).toBe('Export bucket missing');
    expect(reason('en-GB', 'rejected: Logo is wrong')).toBe(
      'Rejected by a reviewer. Logo is wrong',
    );
  });

  it('renders the untranslated detail in its own direction', () => {
    const { container } = render(
      withLocale('ar', <FailureReason reason="rejected: Please fix the logo" />),
    );
    const bdi = container.querySelector('bdi');
    expect(bdi).toHaveAttribute('dir', 'auto');
    expect(bdi).toHaveTextContent('Please fix the logo');
  });
});

const ISSUES: QualityIssue[] = [
  {
    code: 'caption_sync',
    status: 'failed',
    severity: 'error',
    detail: '"Hello": off by 400ms; "World": off by 300ms',
    detailKey: 'captionSyncFailed',
    detailParams: { count: 2 },
  },
  {
    code: 'duration_match',
    status: 'passed',
    severity: 'info',
    detail: 'rendered 15.20s vs target 15s (±2s)',
    detailKey: 'duration',
    detailParams: { rendered: 15.2, target: 15, tolerance: 2 },
  },
  // An older check without a key: its English detail is shown as stored.
  { code: 'codec', status: 'passed', severity: 'info', detail: 'h264 (High) in mp4' },
];

describe('QualityPanel details', () => {
  it('shows check labels and details in Arabic (dual plural)', () => {
    mockFetch([]);
    renderWithSWR(
      withLocale(
        'ar',
        <QualityPanel
          onChanged={vi.fn()}
          render={makeRender({ qualityCheckState: 'FAILED', qualityIssues: ISSUES })}
        />,
      ),
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('تزامن الترجمة المكتوبة');
    expect(items[0]).toHaveTextContent('سطرا ترجمة غير متزامنين مع التعليق الصوتي.');
    expect(items[1]).toHaveTextContent('تطابق المدة');
    expect(items[1]).toHaveTextContent('مدة العرض 15.2 ث مقابل هدف 15 ث (±2 ث).');
    expect(items[2]).toHaveTextContent('h264 (High) in mp4');
  });

  it('shows check labels and details in Simplified Chinese', () => {
    mockFetch([]);
    renderWithSWR(
      withLocale(
        'zh-Hans',
        <QualityPanel
          onChanged={vi.fn()}
          render={makeRender({ qualityCheckState: 'FAILED', qualityIssues: ISSUES })}
        />,
      ),
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('字幕同步');
    expect(items[0]).toHaveTextContent('2 条字幕与配音不同步。');
    expect(items[1]).toHaveTextContent('渲染时长 15.2 秒，目标 15 秒（±2 秒）。');
    expect(items[2]).toHaveTextContent('h264 (High) in mp4');
  });
});
