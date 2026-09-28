// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { IntlTestProvider } from '../../../test/i18n-wrapper';
import type { Locale } from '@/lib/i18n/locales';
import { useProjectName } from '@/lib/client/use-project-name';
import { useNotificationText } from './notification-text';
import { useReviewReason } from './review/automation-panel';
import { useTemplateCategory } from './templates/category';

// BACKLOG 17.9 — "Untitled video", template categories and auto-approval reasons in the reader's
// language; stored English only as the fallback for rows this build cannot translate.

const hook = <T,>(locale: Locale, fn: () => T) =>
  renderHook(fn, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <IntlTestProvider locale={locale} syncDocument={false}>
        {children}
      </IntlTestProvider>
    ),
  }).result.current;

describe('useProjectName', () => {
  it('renders an unnamed project (null or the legacy English words) in the reader’s language', () => {
    const zh = hook('zh-Hans', useProjectName);
    expect(zh(null)).toBe('未命名视频');
    expect(zh('Untitled video')).toBe('未命名视频');
    expect(zh(' Spring sale ')).toBe('Spring sale');
    expect(hook('ar', useProjectName)(null)).toBe('فيديو بلا عنوان');
    expect(hook('en-GB', useProjectName)(undefined)).toBe('Untitled video');
  });

  it('fills an empty project-name parameter of a notification', () => {
    const text = hook(
      'zh-Hans',
      useNotificationText,
    )({
      title: '“Untitled video” is ready for review',
      body: 'x',
      messageKey: 'generationReady',
      messageParams: { name: '' },
    });
    expect(text.title).toContain('未命名视频');
    expect(text.title).not.toContain('Untitled');
  });
});

describe('useTemplateCategory', () => {
  it('translates every built-in category and keeps organisation-typed ones', () => {
    const ar = hook('ar', useTemplateCategory);
    expect(ar('listicle_5')).toBe('قائمة أفضل 5');
    expect(ar('product_launch')).toBe('إطلاق منتج');
    expect(ar('my_own_thing')).toBe('my own thing');
    const zh = hook('zh-Hans', useTemplateCategory);
    expect(zh('listicle_10')).toBe('前 10 清单');
    expect(hook('en-GB', useTemplateCategory)('photo_dump', true)).toBe('Photo dump');
  });
});

describe('useReviewReason', () => {
  it('says why a person must review in the reader’s language, from the code and params', () => {
    const zh = hook('zh-Hans', useReviewReason);
    expect(
      zh({
        decision: 'needs_review',
        code: 'force_approved',
        reason: 'Needs review: the tiktok variant was force-approved',
        params: { platform: 'tiktok' },
        at: '2026-09-28T00:00:00Z',
      }),
    ).toBe('需要审核：TikTok 版本已被强制批准。');
    const ar = hook('ar', useReviewReason);
    expect(
      ar({
        decision: 'needs_review',
        code: 'not_trusted',
        reason: 'x',
        params: { approved: 1, needed: 3 },
        at: '2026-09-28T00:00:00Z',
      }),
    ).toBe('يحتاج إلى مراجعة: يراجع شخصٌ أول 3 فيديوهات لك (تمت الموافقة على 1 من 3 حتى الآن).');
    expect(
      ar({ decision: 'needs_review', code: 'enterprise_plan', at: '2026-09-28T00:00:00Z' }),
    ).toBe('يحتاج إلى مراجعة: تراجع مؤسسات Enterprise فيديوهاتها دائمًا.');
  });

  it('falls back to the stored English for older records and unknown codes', () => {
    const zh = hook('zh-Hans', useReviewReason);
    const legacy = 'Needs review: the tiktok variant was force-approved';
    expect(zh({ decision: 'needs_review', code: 'force_approved', reason: legacy, at: 'x' })).toBe(
      legacy,
    );
    expect(zh({ decision: 'needs_review', code: 'future_code', reason: 'Later', at: 'x' })).toBe(
      'Later',
    );
  });
});
