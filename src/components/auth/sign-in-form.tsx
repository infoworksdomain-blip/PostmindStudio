'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { AuthApiError, authApi } from '@/lib/client/auth';
import { hardNavigate } from '@/lib/client/navigate';
import { AuthCard, AuthError, authLinkClass } from './auth-card';
import { AuthTextField } from './auth-fields';
import { GoogleButton } from './google-button';
import { PasswordField } from './password-field';

// Phase 18 Track A — /sign-in. One generic failure message for a wrong password and an unknown
// address (§5.3); an unverified address is only revealed after the right password.
// 25.6: restyled — "Forgot your password?" sits by the password, sign-up below the form.

export function SignInForm({
  next,
  googleEnabled,
  signupsEnabled,
  initialError,
}: {
  next: string;
  googleEnabled: boolean;
  signupsEnabled: boolean;
  initialError?: unknown;
}) {
  const t = useTranslations('auth.signIn');
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(initialError);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await authApi.signIn({ email, password });
      if (result?.twoFactorRedirect) {
        router.push(`/two-factor?next=${encodeURIComponent(next)}`);
        return;
      }
      hardNavigate(next);
    } catch (err) {
      if (err instanceof AuthApiError && err.code === 'EMAIL_NOT_VERIFIED') {
        router.push(`/verify-email?email=${encodeURIComponent(email)}&sent=1`);
        return;
      }
      setError(err);
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title={t('title')}
      description={t('description')}
      footer={
        signupsEnabled ? (
          <p>
            {t('newHere')}{' '}
            <Link
              className={`${authLinkClass} font-medium text-foreground underline`}
              href={`/sign-up?next=${encodeURIComponent(next)}`}
            >
              {t('noAccount')}
            </Link>
          </p>
        ) : undefined
      }
    >
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
          error={error}
          field="email"
        />
        <div className="space-y-2">
          <PasswordField
            label={t('password')}
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            error={error}
          />
          <div className="flex justify-end">
            <Link
              className={`${authLinkClass} text-[0.8125rem] text-foreground-secondary`}
              href="/forgot-password"
            >
              {t('forgot')}
            </Link>
          </div>
        </div>
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          {t('submit')}
        </Button>
      </form>
      {googleEnabled && <GoogleButton next={next} />}
    </AuthCard>
  );
}
