'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authApi } from '@/lib/client/auth';
import { AuthCard, AuthError } from './auth-card';
import { GoogleButton } from './google-button';
import { PASSWORD_MIN, PasswordField } from './password-field';

// Phase 18 Track A — /sign-up. The server answers the same for a new and an existing address
// (§5.3), so this screen always moves on to "check your email". Verification links land on
// /welcome (onboarding), signed in.

export function SignUpForm({ next, googleEnabled }: { next: string; googleEnabled: boolean }) {
  const t = useTranslations('auth.signUp');
  const router = useRouter();
  const nameId = useId();
  const emailId = useId();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await authApi.signUp({ name: name.trim(), email, password, callbackURL: '/welcome' });
      router.push(`/verify-email?email=${encodeURIComponent(email)}&sent=1`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title={t('title')}
      description={t('description')}
      footer={
        <Link
          className="underline-offset-4 hover:underline"
          href={`/sign-in?next=${encodeURIComponent(next)}`}
        >
          {t('haveAccount')}
        </Link>
      }
    >
      <AuthError error={error} />
      <form onSubmit={(e) => void submit(e)} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor={nameId}>{t('name')}</Label>
          <Input
            id={nameId}
            autoComplete="name"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-10"
          />
        </div>
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
          autoComplete="new-password"
          showStrength
        />
        <p className="text-xs text-muted-foreground">
          {t.rich('terms', {
            terms: (chunks) => (
              <Link className="underline underline-offset-4" href="/legal/terms">
                {chunks}
              </Link>
            ),
            privacy: (chunks) => (
              <Link className="underline underline-offset-4" href="/legal/privacy">
                {chunks}
              </Link>
            ),
          })}
        </p>
        <Button
          type="submit"
          className="h-10 w-full"
          disabled={password.length < PASSWORD_MIN}
          loading={busy}
        >
          {t('submit')}
        </Button>
      </form>
      {googleEnabled && <GoogleButton next="/welcome" />}
    </AuthCard>
  );
}
