import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { LanguageSwitcher } from '@/components/studio/i18n/language-switcher';
import { authPageOptions } from '@/lib/auth/page-options';

// Phase 18 Track A — the signed-out screens (sign-in, sign-up, verify, reset, 2FA, invite).
// Standalone mode only: core mode signs in through PostMind Core.
// These screens have no header, so the interface language switcher sits in the corner: a visitor
// can read the screen in their own language before they have an account (the theme follows the
// system setting until they sign in, where the header has the toggle).

export default function AuthLayout({ children }: { children: ReactNode }) {
  if (!authPageOptions().standalone) notFound();
  return (
    <main className="relative flex min-h-dvh items-start justify-center bg-muted/30 px-4 py-16 sm:items-center">
      <div className="absolute end-3 top-3">
        <LanguageSwitcher labelClassName="hidden sm:inline" />
      </div>
      {children}
    </main>
  );
}
