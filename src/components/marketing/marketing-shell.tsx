import Link from 'next/link';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { BrandLogo } from './brand-mark';
import { LEGAL_DOC_KEYS } from './legal-doc-keys';
import { LanguageSwitcher } from '../studio/i18n/language-switcher';
import { ThemeMenuButton } from '../studio/theme-switcher';

// Phase 18 §3 / 25.5 — the public pages' frame: the PostMind Studio logo (26.2 artwork), Pricing, Sign in,
// "Start free trial", the theme and language switchers, and a footer with the product links and
// every legal document. `entityName` is the operator's legal entity (STUDIO_LEGAL_ENTITY_NAME),
// shown in the copyright line when set. <main> is full width: each page sets its own container
// (the landing page has full-bleed bands).

const NAV_LINK =
  'rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/**
 * `nav={false}` keeps only the mark and wordmark (the 404 page for a signed-in visitor, where
 * Sign in and the trial button would be wrong); `home` is where the mark links.
 */
export function MarketingHeader({ home = '/', nav = true }: { home?: string; nav?: boolean }) {
  const t = useTranslations('marketing.nav');
  return (
    <header className="sticky top-0 z-(--z-sticky) border-b border-border/70 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-4 md:px-8">
        <Link
          href={home}
          className="flex shrink-0 items-center rounded-control focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={t('home')}
        >
          {/* 26.2: the full lockup on phones too (120 × 40 fits at 320 px beside Sign in); the
              theme and language switchers move to the footer below sm to make room. */}
          <BrandLogo eager label={null} />
        </Link>
        {nav && (
          <nav aria-label={t('aria')} className="ms-auto flex items-center gap-0.5 sm:gap-1">
            {/* Phones: "See pricing" is in the hero and the footer; the bar keeps Sign in. */}
            <Link href="/pricing" className={cn(NAV_LINK, 'max-sm:hidden')}>
              {t('pricing')}
            </Link>
            <Link href="/sign-in" className={cn(NAV_LINK, 'max-sm:px-2')}>
              {t('signIn')}
            </Link>
            <Button asChild size="sm" className="ms-1 max-sm:hidden">
              <Link href="/sign-up">{t('startTrial')}</Link>
            </Button>
            <span className="flex items-center gap-0.5 max-sm:hidden sm:gap-1">
              <ThemeMenuButton />
              <LanguageSwitcher />
            </span>
          </nav>
        )}
      </div>
    </header>
  );
}

export function MarketingFooter({ entityName }: { entityName?: string }) {
  const t = useTranslations('marketing.footer');
  const tn = useTranslations('marketing.nav');
  const tl = useTranslations('legal.docs');
  const year = new Date().getUTCFullYear();
  return (
    <footer className="border-t border-border bg-surface-raised/40">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 pt-16 pb-10 md:grid-cols-[1.4fr_1fr_1.6fr] md:px-8">
        <div>
          <BrandLogo />
          <p className="mt-4 max-w-xs text-sm text-pretty text-muted-foreground">{t('tagline')}</p>
        </div>
        <nav aria-label={t('productAria')}>
          <p className="mb-4 text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
            {t('productTitle')}
          </p>
          <ul className="grid gap-2.5 text-sm">
            <li>
              <Link href="/pricing" className="hover:underline">
                {tn('pricing')}
              </Link>
            </li>
            <li>
              <Link href="/sign-in" className="hover:underline">
                {tn('signIn')}
              </Link>
            </li>
            <li>
              <Link href="/sign-up" className="hover:underline">
                {tn('startTrial')}
              </Link>
            </li>
          </ul>
        </nav>
        <nav aria-label={t('legalAria')}>
          <p className="mb-4 text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
            {t('legalTitle')}
          </p>
          <ul className="grid gap-2.5 text-sm sm:grid-cols-2 sm:gap-x-8">
            {LEGAL_DOC_KEYS.map(({ doc, key }) => (
              <li key={doc}>
                <Link href={`/legal/${doc}`} className="hover:underline">
                  {tl(key)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-6 md:px-8">
        <p className="text-xs text-muted-foreground">
          {t('copyright', { year, entity: entityName?.trim() || 'PostMind Studio' })}
        </p>
        {/* 26.2: on phones the header has no room for these; the footer carries them. */}
        <div className="flex items-center gap-1 sm:hidden">
          <ThemeMenuButton />
          <LanguageSwitcher labelClassName="inline" />
        </div>
      </div>
    </footer>
  );
}

export function MarketingShell({
  children,
  entityName,
}: {
  children: ReactNode;
  entityName?: string;
}) {
  return (
    <div className="relative z-10 flex min-h-dvh flex-col bg-background">
      <MarketingHeader />
      <main className="w-full flex-1">{children}</main>
      <MarketingFooter entityName={entityName} />
    </div>
  );
}
