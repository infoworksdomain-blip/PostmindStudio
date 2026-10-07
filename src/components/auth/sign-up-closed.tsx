'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { AuthCard } from './auth-card';

// STUDIO_SIGNUPS_ENABLED=false: invite-only. Invitations still work (/invite/[token]).
// 25.6: a calm screen — what is happening, how to get in (an invitation), and sign in.

export function SignUpClosed() {
  const t = useTranslations('auth.signUp');
  return (
    <AuthCard title={t('closedTitle')} description={t('closedDescription')}>
      <p className="mb-6 text-sm leading-relaxed text-foreground-secondary">{t('closedNext')}</p>
      <Button asChild size="lg" className="w-full">
        <Link href="/sign-in">{t('closedSignIn')}</Link>
      </Button>
    </AuthCard>
  );
}
