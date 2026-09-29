import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { LandingPage } from '@/components/marketing/landing-page';
import { legalDocKey } from '@/components/marketing/legal-doc-keys';
import { LegalDocumentView } from '@/components/marketing/legal-document-view';
import { MarketingShell } from '@/components/marketing/marketing-shell';
import acceptableUse from '../content/legal/en-GB/acceptable-use.md';
import cookies from '../content/legal/en-GB/cookies.md';
import dpa from '../content/legal/en-GB/dpa.md';
import privacy from '../content/legal/en-GB/privacy.md';
import subprocessors from '../content/legal/en-GB/subprocessors.md';
import terms from '../content/legal/en-GB/terms.md';
import { matchPath } from './router';

// Phase 18 public pages in the demo: the landing page and the legal pages render in the marketing
// frame (no app shell), exactly as the app's (marketing) route group does. /pricing and /sign-up
// belong to Tracks C and A; until their screens are in this bundle the demo says so.

const LEGAL: Record<string, string> = {
  terms,
  privacy,
  cookies,
  'acceptable-use': acceptableUse,
  dpa,
  subprocessors,
};

const PLACEHOLDER_MARKER = 'OPERATOR MUST REPLACE';

function Pending({ screen }: { screen: 'pricing' | 'signUp' }) {
  // Demo-only copy (English, like the other tour pages).
  const text =
    screen === 'pricing'
      ? 'The pricing page (tier cards, comparison table, monthly/annual toggle) is built by Phase 18 Track C. Its sample data (plans, invoices) is already served by the demo API.'
      : 'Sign-up and sign-in (email and password, Google, 2FA) are built by Phase 18 Track A. After sign-up, the guided setup starts at #/welcome?new=organisation.';
  return (
    <div className="mx-auto max-w-xl py-24 text-center">
      <p className="font-display text-4xl">{screen === 'pricing' ? 'Pricing' : 'Sign up'}</p>
      <p className="mt-4 text-sm text-muted-foreground">{text}</p>
      <a className="mt-6 inline-block text-primary underline" href="#/welcome?new=organisation">
        Continue to the guided setup
      </a>
    </div>
  );
}

function LegalPage({ doc }: { doc: string }) {
  const t = useTranslations('legal');
  const key = legalDocKey(doc);
  const markdown = LEGAL[doc];
  if (!key || !markdown) return <p className="py-24 text-center">{t('navTitle')}</p>;
  return (
    <LegalDocumentView
      docKey={key}
      markdown={markdown}
      placeholder={markdown.includes(PLACEHOLDER_MARKER)}
      fallback={false}
    />
  );
}

/** The public page for this path, or null when the path belongs to the app. */
export function publicPage(pathname: string): ReactNode | null {
  let body: ReactNode | null = null;
  if (pathname === '/landing') body = <LandingPage />;
  else if (pathname === '/pricing') body = <Pending screen="pricing" />;
  else if (pathname === '/sign-up' || pathname === '/sign-in') body = <Pending screen="signUp" />;
  else {
    const legal = matchPath('/legal/:doc', pathname);
    if (legal) body = <LegalPage doc={legal.doc ?? ''} />;
  }
  return body ? (
    <MarketingShell entityName="Leeds Sourdough Demo Ltd">{body}</MarketingShell>
  ) : null;
}
