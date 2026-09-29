'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { AuthCard } from './auth-card';

// STUDIO_SIGNUPS_ENABLED=false: invite-only. Invitations still work (/invite/[token]).

export function SignUpClosed() {
  const t = useTranslations('auth.signUp');
  return (
    <AuthCard title={t('closedTitle')} description={t('closedDescription')}>
      <Button asChild className="h-10 w-full">
        <Link href="/sign-in">{t('haveAccount')}</Link>
      </Button>
    </AuthCard>
  );
}
