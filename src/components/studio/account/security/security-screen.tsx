'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { authApi, type SessionPayload } from '@/lib/client/auth';
import { PageHeader } from '../../primitives';
import { DeleteAccountSection } from './delete-account-section';
import { PasswordSection } from './password-section';
import { SessionsSection } from './sessions-section';
import { SignInMethodsSection } from './sign-in-methods-section';
import { TwoFactorSection } from './two-factor-section';

// Phase 18 Track A — /account/security: password, two-factor, active sessions, sign-in methods.
// and deleting the account (§5.11).

export function SecurityScreen({ googleEnabled }: { googleEnabled: boolean }) {
  const t = useTranslations('security');
  const [session, setSession] = useState<SessionPayload | null>(null);
  const refresh = useCallback(() => {
    void authApi
      .getSession()
      .then(setSession)
      .catch(() => setSession(null));
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')} />
      <div className="space-y-10">
        <PasswordSection />
        <TwoFactorSection enabled={session?.user.twoFactorEnabled === true} onChanged={refresh} />
        <SessionsSection />
        <SignInMethodsSection googleEnabled={googleEnabled} />
        <DeleteAccountSection />
      </div>
    </div>
  );
}
