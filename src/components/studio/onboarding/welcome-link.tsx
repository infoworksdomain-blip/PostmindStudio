'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useApi } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { ONBOARDING_PATH, type OnboardingResponse } from './onboarding';

// App-shell pointer to /welcome for new users (BACKLOG 13.14): shown only while GET /onboarding
// says the wizard is suggested (not finished, not dismissed). Errors hide it — it is optional.
// 25.4: it takes the place of the sidebar's primary Create button (`fallback`) until setup is done.

export function WelcomeLink({
  onNavigate,
  fallback = null,
  collapsed = false,
}: {
  onNavigate?: () => void;
  /** Shown instead when setup is not suggested (or cannot be read). */
  fallback?: ReactNode;
  /** The desktop icon rail: an icon-sized link (the name stays for screen readers). */
  collapsed?: boolean;
}) {
  const t = useTranslations('shell.nav');
  const pathname = usePathname() ?? '';
  const { data } = useApi<OnboardingResponse>(ONBOARDING_PATH);
  if (!data?.onboarding.suggested) return <>{fallback}</>;
  const active = pathname === '/welcome';
  return (
    <Link
      href="/welcome"
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-9 items-center gap-2.5 rounded-control border border-primary/30 bg-signal-soft px-3 text-sm font-medium text-foreground',
        'transition-colors duration-(--duration-fast) ease-standard hover:border-primary/50',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        collapsed && 'justify-center px-0',
      )}
    >
      <span className={cn(collapsed && 'sr-only')}>{t('getStarted')}</span>
      <ArrowRight
        aria-hidden
        className={cn('size-4 text-primary rtl:-scale-x-100', !collapsed && 'ms-auto')}
        strokeWidth={1.75}
      />
    </Link>
  );
}
