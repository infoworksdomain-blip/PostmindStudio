'use client';

import { useTranslations } from 'next-intl';
import { contrastRatio } from '@/lib/studio/carousel/quality';

// 25.6 — the brand-kit step's live preview: a small title card in the chosen colours and font,
// with the tone words underneath, so the three picks read as one brand before anything is saved.
// The card's text is black or white, whichever reads better on the first colour.

const INK = '#111111';
const PAPER = '#FFFFFF';

/** Black or white text for a #RRGGBB background (the one with more contrast); null if unreadable. */
export function readableOn(background: string): string | null {
  try {
    return contrastRatio(INK, background) >= contrastRatio(PAPER, background) ? INK : PAPER;
  } catch {
    return null;
  }
}

export function BrandPreview({
  palette,
  font,
  tones,
}: {
  palette: string[];
  font: string | null;
  /** The chosen tones, already translated and joined for the locale. */
  tones: string;
}) {
  const t = useTranslations('onboarding.brandKit.preview');
  const background = palette[0];
  const text = background ? readableOn(background) : null;
  const fontFamily = font ? `'${font}', ui-sans-serif, system-ui` : undefined;
  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="text-xs font-medium text-foreground-secondary">
        {t('label')}
      </figcaption>
      <div
        className="flex aspect-[4/5] flex-col justify-end overflow-hidden rounded-panel border border-border bg-surface-raised p-5"
        style={background && text ? { backgroundColor: background, color: text } : undefined}
      >
        <p className="text-[0.6875rem] font-medium opacity-75" style={{ fontFamily }}>
          {t('kicker')}
        </p>
        <p
          className="mt-1.5 text-[1.375rem] leading-[1.15] font-semibold text-balance"
          style={{ fontFamily }}
        >
          {t('headline')}
        </p>
        {palette.length > 1 && (
          <div aria-hidden className="mt-4 flex gap-1.5">
            {palette.slice(1, 6).map((colour) => (
              <span
                key={colour}
                className="size-4 rounded-full ring-1 ring-black/10"
                style={{ backgroundColor: colour }}
              />
            ))}
          </div>
        )}
      </div>
      <p className="text-xs text-foreground-secondary">
        {font ?? t('noFont')}
        {' · '}
        {tones || t('noTone')}
      </p>
    </figure>
  );
}
