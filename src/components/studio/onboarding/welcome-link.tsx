'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useApi } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { ONBOARDING_PATH, type OnboardingResponse } from './onboarding';

// App-shell pointer to /welcome for new users (BACKLOG 13.14): shown only while GET /onboarding
// says the wizard is suggested (not finished, not dismissed). Errors hide it — it is optional.

export function WelcomeLink({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations('shell.nav');
  const pathname = usePathname() ?? '';
  const { data } = useApi<OnboardingResponse>(ONBOARDING_PATH);
  if (!data?.onboarding.suggested) return null;
  const active = pathname === '/welcome';
  return (
    <Link
      href="/welcome"
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-lg border border-primary/30 bg-primary/8 px-3 py-2 text-sm font-medium transition-colors',
        'hover:bg-primary/12 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
      )}
    >
      {t('getStarted')}
      <ArrowRight
        aria-hidden
        className="ms-auto size-4 text-primary rtl:-scale-x-100"
        strokeWidth={1.75}
      />
    </Link>
  );
}
