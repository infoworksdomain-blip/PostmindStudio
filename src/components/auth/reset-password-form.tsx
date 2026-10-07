'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { authApi } from '@/lib/client/auth';
import { AuthCard, AuthError, AuthNotice } from './auth-card';
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
        title={t('invalidTitle')}
        description={t('invalidDescription')}
        footer={
          <Link className="underline-offset-4 hover:underline" href="/forgot-password">
            {t('requestNew')}
          </Link>
        }
      >
        <Button asChild className="h-10 w-full">
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

  return (
    <AuthCard title={t('title')} description={t('description')}>
      {done ? (
        <>
          <AuthNotice>{t('done')}</AuthNotice>
          <Button asChild className="h-10 w-full">
            <Link href="/sign-in">{t('signIn')}</Link>
          </Button>
        </>
      ) : (
        <>
          <AuthError error={failure} />
          <form onSubmit={(e) => void submit(e)} className="space-y-5">
            <PasswordField
              label={t('newPassword')}
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              showStrength
            />
            <Button
              type="submit"
              className="h-10 w-full"
              disabled={password.length < PASSWORD_MIN}
              loading={busy}
            >
              {t('submit')}
            </Button>
          </form>
        </>
      )}
    </AuthCard>
  );
}
