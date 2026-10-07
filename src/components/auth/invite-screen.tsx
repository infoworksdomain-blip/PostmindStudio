'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { APP_HOME } from '@/lib/auth/page-guard';
import { authFetch } from '@/lib/client/auth';
import { hardNavigate } from '@/lib/client/navigate';
import { AuthCard, AuthError, authLinkClass, AuthStatusMark } from './auth-card';

// Phase 18 §2.4 — /invite/[token]: accept an organisation invitation. Only a signed-in user whose
// VERIFIED email matches the invitation can accept (Better Auth checks it:
// requireEmailVerificationOnInvitation). Signed-out visitors are sent to sign in or sign up first
// and come back here.
// 25.6: an invitation that cannot be used gets its own calm state with the next step (ask for a
// new invitation, or carry on into Studio).

interface InvitationView {
  id: string;
  organizationName?: string;
  role?: string | null;
  inviterEmail?: string;
  status?: string;
}

export function InviteScreen({
  invitationId,
  signedIn,
}: {
  invitationId: string;
  signedIn: boolean;
}) {
  const t = useTranslations('auth.invite');
  const back = `/invite/${encodeURIComponent(invitationId)}`;
  const [invitation, setInvitation] = useState<InvitationView | null>(null);
  const [loading, setLoading] = useState(signedIn);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    authFetch<InvitationView>(`/organization/get-invitation?id=${encodeURIComponent(invitationId)}`)
      .then((inv) => !cancelled && setInvitation(inv))
      .catch((err: unknown) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [invitationId, signedIn]);

  const accept = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await authFetch('/organization/accept-invitation', { body: { invitationId } });
      hardNavigate(APP_HOME);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  if (!signedIn) {
    return (
      <AuthCard title={t('title')} description={t('signedOut')}>
        <div className="flex flex-col gap-3">
          <Button asChild size="lg" className="w-full">
            <Link href={`/sign-in?next=${encodeURIComponent(back)}`}>{t('signIn')}</Link>
          </Button>
          <Button asChild variant="outline" size="lg" className="w-full">
            <Link href={`/sign-up?next=${encodeURIComponent(back)}`}>{t('signUp')}</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }

  if (!loading && error && !invitation)
    return (
      <AuthCard
        icon={<AuthStatusMark tone="problem" />}
        title={t('unavailableTitle')}
        description={t('unavailable')}
      >
        <p className="mb-6 text-sm leading-relaxed text-foreground-secondary">
          {t('unavailableNext')}
        </p>
        <Button asChild variant="outline" size="lg" className="w-full">
          <Link href={APP_HOME}>{t('goToStudio')}</Link>
        </Button>
      </AuthCard>
    );

  return (
    <AuthCard
      title={t('title')}
      description={
        invitation?.organizationName
          ? t('joinNamed', { organisation: invitation.organizationName })
          : t('join')
      }
      footer={
        <Link className={authLinkClass} href="/projects">
          {t('notNow')}
        </Link>
      }
    >
      {loading ? (
        <Skeleton className="h-10 w-full" />
      ) : (
        <>
          <AuthError error={error} />
          <Button size="lg" className="w-full" onClick={() => void accept()} loading={busy}>
            {t('accept')}
          </Button>
        </>
      )}
    </AuthCard>
  );
}
