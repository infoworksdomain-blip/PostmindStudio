import Link from 'next/link';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { BrandMark } from './brand-mark';
import { LEGAL_DOC_KEYS } from './legal-doc-keys';
import { LanguageSwitcher } from '../studio/i18n/language-switcher';
import { ThemeMenuButton } from '../studio/theme-switcher';

// Phase 18 §3 / 25.5 — the public pages' frame: the PostMind mark and wordmark, Pricing, Sign in,
// "Start free trial", the theme and language switchers, and a footer with the product links and
// every legal document. `entityName` is the operator's legal entity (STUDIO_LEGAL_ENTITY_NAME),
// shown in the copyright line when set. <main> is full width: each page sets its own container
// (the landing page has full-bleed bands).

const NAV_LINK =
  'rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

export function Wordmark() {
  return (
    <span className="text-[1.05rem] font-semibold tracking-tight whitespace-nowrap">
      PostMind <span className="text-muted-foreground">Studio</span>
    </span>
  );
}

export function MarketingHeader() {
  const t = useTranslations('marketing.nav');
  return (
    <header className="sticky top-0 z-(--z-sticky) border-b border-border/70 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-4 md:px-8">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={t('home')}
        >
          <BrandMark />
          <span className="max-sm:sr-only">
            <Wordmark />
          </span>
        </Link>
        <nav aria-label={t('aria')} className="ms-auto flex items-center gap-0.5 sm:gap-1">
          {/* Phones: "See pricing" is in the hero and the footer; the bar keeps Sign in. */}
          <Link href="/pricing" className={cn(NAV_LINK, 'max-sm:hidden')}>
            {t('pricing')}
          </Link>
          <Link href="/sign-in" className={NAV_LINK}>
            {t('signIn')}
          </Link>
          <Button asChild size="sm" className="ms-1 max-sm:hidden">
            <Link href="/sign-up">{t('startTrial')}</Link>
          </Button>
          <ThemeMenuButton />
          <LanguageSwitcher />
        </nav>
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
          <p className="flex items-center gap-2.5">
            <BrandMark />
            <Wordmark />
          </p>
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
      <div className="mx-auto max-w-7xl border-t border-border px-4 py-6 md:px-8">
        <p className="text-xs text-muted-foreground">
          {t('copyright', { year, entity: entityName?.trim() || 'PostMind Studio' })}
        </p>
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
