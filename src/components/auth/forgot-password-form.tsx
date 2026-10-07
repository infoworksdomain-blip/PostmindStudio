'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { AuthApiError, authApi } from '@/lib/client/auth';
import { AuthCard, AuthError, AuthStatusMark, authLinkClass, SupportContact } from './auth-card';
import { AuthTextField } from './auth-fields';

// Phase 18 §5.3 — /forgot-password always answers "if an account exists, we've sent a link".
// Only a rate limit (429) is shown as an error.
// 25.6: the sent state says what happens next (open the link, it works for an hour) and offers a
// different address.

export function ForgotPasswordForm({ supportEmail }: { supportEmail?: string }) {
  const t = useTranslations('auth.forgot');
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

  const back = (
    <Link className={authLinkClass} href="/sign-in">
      {t('backToSignIn')}
    </Link>
  );

  if (done)
    return (
      <AuthCard
        icon={<AuthStatusMark tone="success" />}
        title={t('sentTitle')}
        description={t('sent')}
        footer={back}
      >
        <p className="text-sm leading-relaxed text-foreground-secondary">{t('sentNext')}</p>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="mt-6 w-full"
          onClick={() => setDone(false)}
        >
          {t('tryAnother')}
        </Button>
        <SupportContact email={supportEmail} />
      </AuthCard>
    );

  return (
    <AuthCard title={t('title')} description={t('description')} footer={back}>
      <AuthError error={error} />
      <form onSubmit={(e) => void submit(e)} className="space-y-5">
        <AuthTextField
          label={t('email')}
          type="email"
          autoComplete="email"
          inputMode="email"
          spellCheck={false}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          {t('submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
