'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthApiError, authApi } from '@/lib/client/auth';
import { AuthCard, AuthError } from './auth-card';
import { GoogleButton } from './google-button';
import { PasswordField } from './password-field';

// Phase 18 Track A — /sign-in. One generic failure message for a wrong password and an unknown
// address (§5.3); an unverified address is only revealed after the right password.

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
  const emailId = useId();
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
      window.location.assign(next);
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
        <>
          <Link className="underline-offset-4 hover:underline" href="/forgot-password">
            {t('forgot')}
          </Link>
          {signupsEnabled && (
            <Link
              className="underline-offset-4 hover:underline"
              href={`/sign-up?next=${encodeURIComponent(next)}`}
            >
              {t('noAccount')}
            </Link>
          )}
        </>
      }
    >
      <AuthError error={error} />
      <form onSubmit={(e) => void submit(e)} className="space-y-5" noValidate={false}>
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
        <PasswordField
          label={t('password')}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <Button type="submit" className="h-10 w-full" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {t('submit')}
        </Button>
      </form>
      {googleEnabled && <GoogleButton next={next} />}
    </AuthCard>
  );
}
