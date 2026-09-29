import Link from 'next/link';
import type { ReactNode } from 'react';
import { Film } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { LEGAL_DOC_KEYS } from './legal-doc-keys';
import { LanguageSwitcher } from '../studio/i18n/language-switcher';

// Phase 18 §3 — the public pages' frame: wordmark, Pricing, Sign in, "Start free trial", the
// language switcher, and a footer with every legal document. `entityName` is the operator's
// legal entity (STUDIO_LEGAL_ENTITY_NAME), shown in the copyright line when set.

export function MarketingHeader() {
  const t = useTranslations('marketing.nav');
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 md:px-8">
        <Link href="/" className="flex items-center gap-2" aria-label={t('home')}>
          <span className="grid size-7 place-items-center rounded-md bg-foreground text-background">
            <Film className="size-4" strokeWidth={2} />
          </span>
          <span className="font-display text-xl leading-none whitespace-nowrap max-sm:sr-only">
            PostMind <em className="text-primary not-italic">Studio</em>
          </span>
        </Link>
        <nav aria-label={t('aria')} className="ms-auto flex items-center gap-1 sm:gap-2">
          <Link
            href="/pricing"
            className="rounded-md px-3 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {t('pricing')}
          </Link>
          <Link
            href="/sign-in"
            className="rounded-md px-3 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {t('signIn')}
          </Link>
          <Button asChild size="sm" className="max-sm:hidden">
            <Link href="/sign-up">{t('startTrial')}</Link>
          </Button>
          <LanguageSwitcher />
        </nav>
      </div>
    </header>
  );
}

export function MarketingFooter({ entityName }: { entityName?: string }) {
  const t = useTranslations('marketing.footer');
  const tl = useTranslations('legal.docs');
  const year = new Date().getUTCFullYear();
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 md:grid-cols-[1fr_auto] md:px-8">
        <div>
          <p className="font-display text-2xl">
            PostMind <em className="text-primary not-italic">Studio</em>
          </p>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">{t('tagline')}</p>
          <p className="mt-6 text-xs text-muted-foreground">
            {t('copyright', { year, entity: entityName?.trim() || 'PostMind Studio' })}
          </p>
        </div>
        <nav aria-label={t('legalAria')}>
          <p className="mb-3 text-xs tracking-[0.2em] text-muted-foreground uppercase">
            {t('legalTitle')}
          </p>
          <ul className="grid gap-2 text-sm sm:grid-cols-2 sm:gap-x-8">
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
    <div className="relative z-10 flex min-h-dvh flex-col">
      <MarketingHeader />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 md:px-8">{children}</main>
      <MarketingFooter entityName={entityName} />
    </div>
  );
}
