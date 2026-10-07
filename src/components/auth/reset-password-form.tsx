'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { authApi } from '@/lib/client/auth';
import { AuthCard, AuthError, AuthStatusMark, authLinkClass } from './auth-card';
import { PASSWORD_MIN, PasswordField } from './password-field';

// Phase 18 §5.1 — /reset-password?token=… (Better Auth redirects here from the emailed link, or
// with ?error=INVALID_TOKEN). A reset signs out every session.

export function ResetPasswordForm({ token, error }: { token?: string; error?: string }) {
  const t = useTranslations('auth.reset');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  if (!token || error) {
    return (
      <AuthCard
        icon={<AuthStatusMark tone="problem" />}
        title={t('invalidTitle')}
        description={t('invalidDescription')}
        footer={
          <Link className={authLinkClass} href="/sign-in">
            {t('backToSignIn')}
          </Link>
        }
      >
        <Button asChild size="lg" className="w-full">
          <Link href="/forgot-password">{t('requestNew')}</Link>
        </Button>
      </AuthCard>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(undefined);
    try {
      await authApi.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <AuthCard
        icon={<AuthStatusMark tone="success" />}
        title={t('doneTitle')}
        description={t('done')}
      >
        <Button asChild size="lg" className="w-full">
          <Link href="/sign-in">{t('signIn')}</Link>
        </Button>
      </AuthCard>
    );

  return (
    <AuthCard title={t('title')} description={t('description')}>
      <AuthError error={failure} />
      <form onSubmit={(e) => void submit(e)} className="space-y-5">
        <PasswordField
          label={t('newPassword')}
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          showStrength
          error={failure}
        />
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={password.length < PASSWORD_MIN}
          loading={busy}
        >
          {t('submit')}
        </Button>
      </form>
    </AuthCard>
  );
}
