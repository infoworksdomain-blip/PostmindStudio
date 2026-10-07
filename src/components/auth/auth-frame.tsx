import type { ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LanguageSwitcher } from '@/components/studio/i18n/language-switcher';
import { imgProps, STUDIO_CLIPS, type StudioClip } from '@/lib/marketing/media';
import { marketingSrc } from '@/lib/marketing/media-src';
import { cn } from '@/lib/utils';

// BACKLOG 25.6 — the frame every signed-out screen shares (src/app/(auth)/layout.tsx and the demo's
// public pages). From lg up it is two panes: the form column (wordmark, generous whitespace, a
// form no wider than 400px) and a quiet brand panel showing real product output with one line
// of value. Below lg the brand panel is not rendered visible and the form takes the screen.
// The interface language switcher sits in the top corner: these screens have no header, and a
// visitor must be able to read them in their own language before they have an account.

/** "PostMind Studio" with the vermilion record dot, the product's one accent. */
export function AuthWordmark() {
  const t = useTranslations('auth.shell');
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-2 rounded-control text-[0.95rem] leading-none font-semibold tracking-tight focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
    >
      <span aria-hidden className="size-2.5 rounded-full bg-primary" />
      {t('brand')}
    </Link>
  );
}

/** Two posts made with Studio (25.5 showcase media), shown as phones beside the form. */
function ClipPhone({ clip, className }: { clip: StudioClip; className?: string }) {
  const { small, large } = clip.poster;
  return (
    <div
      className={cn(
        'overflow-hidden rounded-[1.75rem] border-[6px] border-foreground bg-foreground shadow-overlay',
        className,
      )}
    >
      <picture>
        <source
          type="image/webp"
          srcSet={`${marketingSrc(small.path)} ${small.width}w, ${marketingSrc(large.path)} ${large.width}w`}
          sizes="(min-width: 1280px) 15rem, 12rem"
        />
        <img
          {...imgProps(clip.poster.fallback)}
          alt=""
          decoding="async"
          className="block aspect-[9/16] h-auto w-full object-cover"
        />
      </picture>
    </div>
  );
}

function BrandPanel() {
  const t = useTranslations('auth.shell');
  return (
    <aside
      aria-label={t('panelLabel')}
      className="relative hidden overflow-hidden border-s border-border bg-surface-raised lg:flex lg:flex-col"
    >
      <div className="max-w-md px-12 pt-24 xl:px-16">
        <p className="text-[1.75rem] leading-[1.15] font-semibold tracking-tight text-balance">
          {t('valueStatement')}
        </p>
        <p className="mt-4 text-[0.9375rem] leading-relaxed text-foreground-secondary">
          {t('valueDetail')}
        </p>
      </div>
      {/* Real Studio output, not a mock-up: an AI video and a slideshow. */}
      <div
        role="img"
        aria-label={t('panelAlt')}
        className="relative mt-12 flex flex-1 items-start justify-center gap-6 px-12 pb-12"
      >
        <ClipPhone clip={STUDIO_CLIPS.seedanceBread} className="w-48 xl:w-60" />
        <ClipPhone clip={STUDIO_CLIPS.coastlineStays} className="mt-16 w-40 xl:w-52" />
      </div>
    </aside>
  );
}

export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative grid min-h-dvh bg-background lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="absolute end-4 top-4 z-(--z-raised) sm:end-6 sm:top-5">
        <LanguageSwitcher labelClassName="hidden sm:inline" />
      </div>
      <div className="flex min-w-0 flex-col px-4 pt-5 pb-10 sm:px-8 lg:px-12 xl:px-16">
        <div className="flex h-9 items-center">
          <AuthWordmark />
        </div>
        <main className="flex flex-1 flex-col items-center justify-center pt-12 pb-6 sm:pt-16">
          <div className="flex w-full max-w-[400px] flex-col gap-4">{children}</div>
        </main>
      </div>
      <BrandPanel />
    </div>
  );
}
