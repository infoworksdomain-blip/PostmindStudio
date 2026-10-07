import type { ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LanguageSwitcher } from '@/components/studio/i18n/language-switcher';
import { FLOW_SCREENS, imgProps } from '@/lib/marketing/media';

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

/** The screen behind the form: the review screen, in the theme the visitor is using. */
function BrandPanel() {
  const t = useTranslations('auth.shell');
  const screen = FLOW_SCREENS.review;
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
      {/* The screenshot runs to the window's far edge: product output, not decoration. */}
      <div className="relative mt-14 flex-1 ps-12 xl:ps-16">
        <div className="overflow-hidden rounded-ss-panel border-s border-t border-border bg-background shadow-overlay">
          {/* eslint-disable-next-line @next/next/no-img-element -- the demo inlines these as data: URLs */}
          <img
            {...imgProps(screen.light)}
            alt={t('panelAlt')}
            loading="lazy"
            decoding="async"
            className="block h-auto w-full max-w-none dark:hidden"
          />
          {/* eslint-disable-next-line @next/next/no-img-element -- as above */}
          <img
            {...imgProps(screen.dark)}
            alt={t('panelAlt')}
            loading="lazy"
            decoding="async"
            className="hidden h-auto w-full max-w-none dark:block"
          />
        </div>
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
