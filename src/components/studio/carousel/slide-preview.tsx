'use client';

import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Section } from '../primitives';
import type { CarouselIssue, CarouselView, PreviewSlide } from './model';

// 21.6 — the carousel's live preview: which posts are on which slide, the selected slide as it
// will be rendered (server-rendered JPEG), quality notes, and the rendered PNGs to download.

const ISSUE_CODES = [
  'text_outside_safe_area',
  'content_overflow',
  'image_stretched',
  'low_contrast',
  'hook_without_image',
] as const;
type IssueCode = (typeof ISSUE_CODES)[number];
const isIssueCode = (c: string): c is IssueCode => (ISSUE_CODES as readonly string[]).includes(c);

export function SlidePreview({
  slides,
  current,
  onSelect,
  previewing,
  previewError,
  issues,
  removedCharacters,
  render,
  aiGenerated,
}: {
  slides: PreviewSlide[];
  current: PreviewSlide | undefined;
  onSelect: (index: number) => void;
  previewing: boolean;
  previewError: string | null;
  issues: CarouselIssue[];
  removedCharacters: number;
  render: CarouselView['render'];
  aiGenerated: boolean;
}) {
  const t = useTranslations('carousel.preview');
  return (
    <Section variant="panel" title={t('title')} description={t('description')}>
      <div className="flex flex-col gap-3" aria-busy={previewing}>
        {previewError && (
          <p role="alert" className="text-sm text-destructive">
            {previewError}
          </p>
        )}
        {current ? (
          <figure className="flex flex-col gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- server-rendered data URL */}
            <img
              src={current.image}
              alt={t('slideAlt', { n: current.index + 1, total: slides.length })}
              className="aspect-[4/5] w-full rounded-lg border border-border object-contain"
            />
            <figcaption className="flex items-center gap-2 text-xs text-muted-foreground">
              {previewing && <Loader2 className="size-3 animate-spin" />}
              {t('slideCaption', {
                n: current.index + 1,
                total: slides.length,
                kind: current.kind,
              })}
            </figcaption>
          </figure>
        ) : (
          <p className="text-sm text-muted-foreground">
            {previewing ? t('rendering') : t('empty')}
          </p>
        )}
        {slides.length > 0 && (
          <ol aria-label={t('breakdown')} className="grid grid-cols-4 gap-2 sm:grid-cols-5">
            {slides.map((s) => (
              <li key={s.index}>
                <button
                  type="button"
                  aria-current={current?.index === s.index}
                  aria-label={t('selectSlide', { n: s.index + 1 })}
                  onClick={() => onSelect(s.index)}
                  className={cn(
                    'block w-full overflow-hidden rounded-md border-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    current?.index === s.index ? 'border-primary' : 'border-transparent',
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- data URL thumbnail */}
                  <img src={s.image} alt="" className="aspect-[4/5] w-full object-cover" />
                </button>
              </li>
            ))}
          </ol>
        )}
        {slides.length > 10 && <p className="text-xs text-muted-foreground">{t('overTen')}</p>}
        {removedCharacters > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('removedCharacters', { count: removedCharacters })}
          </p>
        )}
        {issues.length > 0 && (
          <ul className="flex flex-col gap-1 text-xs text-destructive">
            {issues.map((issue, i) => (
              <li key={`${issue.slide}-${issue.code}-${i}`}>
                {t('issue', {
                  n: issue.slide + 1,
                  problem: isIssueCode(issue.code) ? t(`issues.${issue.code}`) : issue.detail,
                })}
              </li>
            ))}
          </ul>
        )}
        {aiGenerated && <p className="text-xs text-muted-foreground">{t('aiLabel')}</p>}
        {render && render.slides.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-border pt-3">
            <p className="text-sm font-medium">{t('renderedTitle')}</p>
            <ul className="flex flex-wrap gap-2 text-xs">
              {render.slides.map((s) => (
                <li key={s.index}>
                  <a href={s.pngUrl} download className="underline" target="_blank" rel="noopener">
                    {t('slidePng', { n: s.index + 1 })}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}
