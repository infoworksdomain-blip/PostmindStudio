import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
// The (auth) route group's frame (src/app/(auth)/layout.tsx renders the same component).
import { AuthFrame } from '@/components/auth/auth-frame';
import { InviteScreen } from '@/components/auth/invite-screen';
import { SignInForm } from '@/components/auth/sign-in-form';
import { SignUpForm } from '@/components/auth/sign-up-form';
import { TwoFactorForm } from '@/components/auth/two-factor-form';
import { VerifyEmailScreen } from '@/components/auth/verify-email-screen';
import { LandingPage } from '@/components/marketing/landing-page';
import { PricingScreen } from '@/components/studio/billing/pricing-screen';
import { legalDocKey } from '@/components/marketing/legal-doc-keys';
import { LegalDocumentView } from '@/components/marketing/legal-document-view';
import { MarketingShell } from '@/components/marketing/marketing-shell';
import { legalTextState } from '@/lib/legal/markers';
import acceptableUse from '../content/legal/en-GB/acceptable-use.md';
import cookies from '../content/legal/en-GB/cookies.md';
import dpa from '../content/legal/en-GB/dpa.md';
import privacy from '../content/legal/en-GB/privacy.md';
import subprocessors from '../content/legal/en-GB/subprocessors.md';
import terms from '../content/legal/en-GB/terms.md';
import { demoPricing } from './api/handlers/p18-billing';
import { setBillingState } from './api/billing-state';
import { isSignedIn, setSignedIn } from './api/session-state';
import { matchPath, navigate } from './router';
import { DemoCheckout } from './tour/demo-checkout';

// Phase 18 public pages in the demo: the landing page (at "#/", where the demo opens, signed out),
// pricing and legal pages render in the marketing frame (no app shell), exactly as the app's
// (marketing) route group does; sign-up, sign-in, two-step, invite and verify-email render Track
// A's real screens in the (auth) layout, with a small demo note where the demo differs (any email
// and password sign in; a "Verify (demo)" button stands in for the emailed link). Pricing uses the
// §P.2 reference prices (sample data); the auth calls are answered by demo/api/auth.ts (nothing is
// created).

const LEGAL: Record<string, string> = {
  terms,
  privacy,
  cookies,
  'acceptable-use': acceptableUse,
  dpa,
  subprocessors,
};

/** A small note beside a real auth screen where the demo behaves differently. */
function DemoNote({ children }: { children: ReactNode }) {
  return (
    <p
      role="note"
      lang="en"
      dir="ltr"
      className="w-full rounded-field border border-dashed border-border-strong bg-surface-raised px-3 py-2 text-[0.8125rem] text-foreground-secondary"
    >
      <span className="font-semibold text-foreground">Demo: </span>
      {children}
    </p>
  );
}

/** The emailed link's job: signed in, then onboarding for a new organisation (no plan yet). */
function verifyAndContinue(): void {
  setBillingState('no_plan');
  setSignedIn(true);
  navigate('/welcome?new=organisation');
}

/** A same-site `next` path (as the app's nextParam allows), else Home (25.4). */
function nextPath(search: URLSearchParams): string {
  const next = search.get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/home';
}

function authPage(pathname: string, search: URLSearchParams): ReactNode | null {
  // Full-page navigations after sign-in go through the demo's hardNavigate shim
  // (demo/shims/hard-navigate.ts), which keeps them inside the hash-routed page.
  if (pathname === '/sign-up') return <SignUpForm next="/welcome?new=organisation" googleEnabled />;
  if (pathname === '/sign-in')
    return (
      <>
        <DemoNote>
          any email and password work and open the sample organisation (Leeds Sourdough, Standard).
          amara@leedssourdough.example has two-step verification on: any 6-digit code.
        </DemoNote>
        <SignInForm next={nextPath(search)} googleEnabled signupsEnabled />
      </>
    );
  if (pathname === '/two-factor') return <TwoFactorForm next={nextPath(search)} />;
  const invite = matchPath('/invite/:token', pathname);
  if (invite) return <InviteScreen invitationId={invite.token ?? ''} signedIn={isSignedIn()} />;
  if (pathname === '/verify-email')
    return (
      <>
        <VerifyEmailScreen
          email={search.get('email') ?? undefined}
          supportEmail="support@leeds-sourdough.example"
        />
        <DemoNote>
          no email is sent. Stand in for the link in it:{' '}
          <button
            type="button"
            onClick={verifyAndContinue}
            className="font-medium text-primary underline underline-offset-4 hover:no-underline"
          >
            Verify (demo) and continue to set-up
          </button>
        </DemoNote>
      </>
    );
  return null;
}

function LegalPage({ doc }: { doc: string }) {
  const t = useTranslations('legal');
  const key = legalDocKey(doc);
  const markdown = LEGAL[doc];
  if (!key || !markdown) return <p className="py-24 text-center">{t('navTitle')}</p>;
  const state = legalTextState(markdown);
  return (
    <LegalDocumentView
      docKey={key}
      markdown={markdown}
      placeholder={state !== 'ready'}
      draft={state === 'fill_in'}
      fallback={false}
    />
  );
}

/** The public page for this path, or null when the path belongs to the app. */
export function publicPage(pathname: string, search = new URLSearchParams()): ReactNode | null {
  // Where the app would send the browser to Stripe: the demo's own simulated checkout.
  if (pathname === '/demo-checkout') return <DemoCheckout search={search} />;
  const auth = authPage(pathname, search);
  if (auth) return <AuthFrame>{auth}</AuthFrame>;
  let body: ReactNode | null = null;
  // The app's "/" is the landing page; "/landing" is kept for older tour links.
  if (pathname === '/' || pathname === '/landing') body = <LandingPage />;
  else if (pathname === '/pricing') body = <PricingScreen pricing={demoPricing()} />;
  else {
    const legal = matchPath('/legal/:doc', pathname);
    if (legal) body = <LegalPage doc={legal.doc ?? ''} />;
  }
  return body ? (
    <MarketingShell entityName="Leeds Sourdough Demo Ltd">{body}</MarketingShell>
  ) : null;
}
