import { useSyncExternalStore } from 'react';
import { LogIn, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DEFAULT_BILLING_STATE, setBillingState } from '../api/billing-state';
import { hasSignedOut, isSignedIn, setSignedIn, subscribeSession } from '../api/session-state';
import { navigate, useLocation } from '../router';
import { BillingSwitcher } from './billing-switcher';

// Slim strip above every page: says plainly that this is a demo with fictional sample data, links
// the landing page and the tour pages (workflows and the "Everything built" index first), switches
// the demo's plan and billing state, and resets the demo (back to the signed-out landing page).
// Signed out, it offers "Enter app as sample user"; after signing out, a strip under it also
// offers "Sign back in (demo)". Stays one line on phones (short labels; the strip scrolls
// sideways, never the page).

const LINKS = [
  { href: '#/', path: '/', label: 'Home', short: 'Home' },
  { href: '#/tour', path: '/tour', label: 'Tour', short: 'Tour' },
  { href: '#/tour/workflows', path: '/tour/workflows', label: 'Workflows', short: 'Flows' },
  { href: '#/tour/features', path: '/tour/features', label: 'Everything built', short: 'Built' },
  { href: '#/tour/whats-new', path: '/tour/whats-new', label: 'What’s new', short: 'New' },
  { href: '#/tour/system', path: '/tour/system', label: 'Behind the scenes', short: 'Behind' },
  { href: '#/tour/not-built', path: '/tour/not-built', label: 'Not built yet', short: 'Not built' },
  // 21.5: the app screens are seen as the customer (no costs); the Admin Centre as PostMind staff.
  { href: '#/admin', path: '/admin', label: 'Admin (staff view)', short: 'Admin' },
] as const;

export function useSignedIn(): boolean {
  return useSyncExternalStore(subscribeSession, isSignedIn, isSignedIn);
}

/** Back to the start: the signed-out landing page, Growth monthly, fresh sample data (reloads). */
function resetDemo(): void {
  setBillingState(DEFAULT_BILLING_STATE);
  setSignedIn(false);
  navigate('/', { replace: true });
  window.location.reload();
}

/** Skip the sign-in screen: straight into the sample organisation. */
export function signBackIn(): void {
  setSignedIn(true);
  navigate('/home');
}

function SignedOutStrip() {
  return (
    <div
      role="status"
      lang="en"
      dir="ltr"
      className="relative z-30 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-primary/30 bg-primary/10 px-3 py-2 text-sm md:px-5"
    >
      <span>You signed out of the demo. In the live app you would now sign in again.</span>
      <button
        type="button"
        onClick={signBackIn}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <LogIn aria-hidden className="size-3.5" /> Sign back in (demo)
      </button>
    </div>
  );
}

export function DemoBar() {
  const { pathname } = useLocation();
  const signedIn = useSignedIn();
  const signedOutNow = !signedIn && hasSignedOut();
  return (
    <>
      <div
        role="region"
        aria-label="Demo build"
        // English demo chrome: left to right in every interface language.
        lang="en"
        dir="ltr"
        className="relative z-30 flex h-8 items-center gap-3 overflow-x-auto bg-foreground px-3 text-[0.72rem] whitespace-nowrap text-background [scrollbar-width:none] md:px-5 [&::-webkit-scrollbar]:hidden"
      >
        <p className="flex shrink-0 items-center gap-2">
          <span aria-hidden className="size-1.5 shrink-0 animate-rec rounded-full bg-primary" />
          <span className="font-semibold tracking-wide">Demo build</span>
          <span className="hidden text-background/70 2xl:inline">
            · sample data for Leeds Sourdough (fictional)
          </span>
        </p>
        <nav aria-label="Demo tour" className="ms-auto flex items-center gap-0.5">
          {LINKS.map((l) => {
            const active = pathname === l.path;
            return (
              <a
                key={l.href}
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded px-2 py-1 transition-colors hover:bg-background/10 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none',
                  active
                    ? 'text-background underline decoration-primary decoration-2 underline-offset-4'
                    : 'text-background/75',
                )}
              >
                <span className="lg:hidden">{l.short}</span>
                <span className="hidden lg:inline">{l.label}</span>
              </a>
            );
          })}
        </nav>
        <BillingSwitcher />
        {!signedIn && (
          <button
            type="button"
            onClick={signBackIn}
            className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 font-medium text-primary-foreground hover:opacity-90 focus-visible:ring-2 focus-visible:ring-background focus-visible:outline-none"
          >
            <LogIn aria-hidden className="size-3" /> Enter app as sample user
          </button>
        )}
        <button
          type="button"
          onClick={resetDemo}
          title="Reset demo: the signed-out landing page, Growth monthly, fresh sample data"
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-background/75 transition-colors hover:bg-background/10 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
        >
          <RotateCcw aria-hidden className="size-3" /> Reset demo
        </button>
      </div>
      {signedOutNow && <SignedOutStrip />}
    </>
  );
}
