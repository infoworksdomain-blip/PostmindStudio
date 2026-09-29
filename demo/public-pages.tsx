import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { SignInForm } from '@/components/auth/sign-in-form';
import { SignUpForm } from '@/components/auth/sign-up-form';
import { VerifyEmailScreen } from '@/components/auth/verify-email-screen';
import { LandingPage } from '@/components/marketing/landing-page';
import { PricingScreen } from '@/components/studio/billing/pricing-screen';
import { legalDocKey } from '@/components/marketing/legal-doc-keys';
import { LegalDocumentView } from '@/components/marketing/legal-document-view';
import { MarketingShell } from '@/components/marketing/marketing-shell';
import acceptableUse from '../content/legal/en-GB/acceptable-use.md';
import cookies from '../content/legal/en-GB/cookies.md';
import dpa from '../content/legal/en-GB/dpa.md';
import privacy from '../content/legal/en-GB/privacy.md';
import subprocessors from '../content/legal/en-GB/subprocessors.md';
import terms from '../content/legal/en-GB/terms.md';
import { demoPricing } from './api/handlers/p18-billing';
import { matchPath } from './router';

// Phase 18 public pages in the demo: the landing, pricing and legal pages render in the marketing
// frame (no app shell), exactly as the app's (marketing) route group does; sign-up, sign-in and
// verify-email render Track A's real screens in the (auth) layout. Pricing uses the §P.2 reference
// prices (sample data); the auth calls are answered by demo/api/auth.ts (nothing is created).

const LEGAL: Record<string, string> = {
  terms,
  privacy,
  cookies,
  'acceptable-use': acceptableUse,
  dpa,
  subprocessors,
};

const PLACEHOLDER_MARKER = 'OPERATOR MUST REPLACE';

/** The (auth) route group's frame (src/app/(auth)/layout.tsx). */
function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-start justify-center bg-muted/30 px-4 py-16 sm:items-center">
      {children}
    </main>
  );
}

function authPage(pathname: string, search: URLSearchParams): ReactNode | null {
  // The demo is hash-routed: `next` must stay inside it (window.location.assign after sign-in).
  if (pathname === '/sign-up') return <SignUpForm next="/welcome?new=organisation" googleEnabled />;
  if (pathname === '/sign-in') return <SignInForm next="#/projects" googleEnabled signupsEnabled />;
  if (pathname === '/verify-email')
    return (
      <VerifyEmailScreen
        email={search.get('email') ?? undefined}
        supportEmail="support@leeds-sourdough.example"
      />
    );
  return null;
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
export function publicPage(pathname: string, search = new URLSearchParams()): ReactNode | null {
  const auth = authPage(pathname, search);
  if (auth) return <AuthFrame>{auth}</AuthFrame>;
  let body: ReactNode | null = null;
  if (pathname === '/landing') body = <LandingPage />;
  else if (pathname === '/pricing')
    body = <PricingScreen pricing={demoPricing()} salesEmail="sales@leeds-sourdough.example" />;
  else {
    const legal = matchPath('/legal/:doc', pathname);
    if (legal) body = <LegalPage doc={legal.doc ?? ''} />;
  }
  return body ? (
    <MarketingShell entityName="Leeds Sourdough Demo Ltd">{body}</MarketingShell>
  ) : null;
}
