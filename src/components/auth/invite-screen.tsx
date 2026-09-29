'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { authFetch } from '@/lib/client/auth';
import { hardNavigate } from '@/lib/client/navigate';
import { AuthCard, AuthError } from './auth-card';

// Phase 18 §2.4 — /invite/[token]: accept an organisation invitation. Only a signed-in user whose
// VERIFIED email matches the invitation can accept (Better Auth checks it:
// requireEmailVerificationOnInvitation). Signed-out visitors are sent to sign in or sign up first
// and come back here.

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
      hardNavigate('/projects');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  if (!signedIn) {
    return (
      <AuthCard title={t('title')} description={t('signedOut')}>
        <div className="flex flex-col gap-3">
          <Button asChild className="h-10 w-full">
            <Link href={`/sign-in?next=${encodeURIComponent(back)}`}>{t('signIn')}</Link>
          </Button>
          <Button asChild variant="outline" className="h-10 w-full">
            <Link href={`/sign-up?next=${encodeURIComponent(back)}`}>{t('signUp')}</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t('title')}
      description={
        invitation?.organizationName
          ? t('joinNamed', { organisation: invitation.organizationName })
          : t('join')
      }
      footer={
        <Link className="underline-offset-4 hover:underline" href="/projects">
          {t('notNow')}
        </Link>
      }
    >
      {loading ? (
        <Skeleton className="h-10 w-full" />
      ) : error && !invitation ? (
        <p className="text-sm text-muted-foreground">{t('unavailable')}</p>
      ) : (
        <>
          <AuthError error={error} />
          <Button className="h-10 w-full" onClick={() => void accept()} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {t('accept')}
          </Button>
        </>
      )}
    </AuthCard>
  );
}
