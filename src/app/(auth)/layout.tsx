import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { AuthFrame } from '@/components/auth/auth-frame';
import { authPageOptions } from '@/lib/auth/page-options';

// Phase 18 Track A — the signed-out screens (sign-in, sign-up, verify, reset, 2FA, invite).
// Standalone mode only: core mode signs in through PostMind Core.
// 25.6: the shared two-pane frame (src/components/auth/auth-frame.tsx) — the form column with the
// wordmark, a quiet brand panel from lg up, and the interface language switcher in the corner (the
// theme follows the system setting until they sign in, where the header has the toggle).

export default function AuthLayout({ children }: { children: ReactNode }) {
  if (!authPageOptions().standalone) notFound();
  return <AuthFrame>{children}</AuthFrame>;
}
