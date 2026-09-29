import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { authPageOptions } from '@/lib/auth/page-options';

// Phase 18 Track A — the signed-out screens (sign-in, sign-up, verify, reset, 2FA, invite).
// Standalone mode only: core mode signs in through PostMind Core.

export default function AuthLayout({ children }: { children: ReactNode }) {
  if (!authPageOptions().standalone) notFound();
  return (
    <main className="flex min-h-dvh items-start justify-center bg-muted/30 px-4 py-16 sm:items-center">
      {children}
    </main>
  );
}
