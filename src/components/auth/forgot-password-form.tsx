'use client';

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthApiError, authApi } from '@/lib/client/auth';
import { AuthCard, AuthError, AuthNotice, SupportContact } from './auth-card';

// Phase 18 §5.3 — /forgot-password always answers "if an account exists, we've sent a link".
// Only a rate limit (429) is shown as an error.

export function ForgotPasswordForm({ supportEmail }: { supportEmail?: string }) {
  const t = useTranslations('auth.forgot');
  const emailId = useId();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await authApi.requestReset(email);
      setDone(true);
    } catch (err) {
      if (err instanceof AuthApiError && err.status === 429) setError(err);
      else setDone(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title={t('title')}
      description={t('description')}
      footer={
        <Link className="underline-offset-4 hover:underline" href="/sign-in">
          {t('backToSignIn')}
        </Link>
      }
    >
      {done ? (
        <>
          <AuthNotice>{t('sent')}</AuthNotice>
          <SupportContact email={supportEmail} />
        </>
      ) : (
        <>
          <AuthError error={error} />
          <form onSubmit={(e) => void submit(e)} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor={emailId}>{t('email')}</Label>
              <Input
                id={emailId}
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-10"
              />
            </div>
            <Button type="submit" className="h-10 w-full" loading={busy}>
              {t('submit')}
            </Button>
          </form>
        </>
      )}
    </AuthCard>
  );
}
