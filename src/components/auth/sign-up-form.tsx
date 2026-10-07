'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { authApi } from '@/lib/client/auth';
import { AuthCard, AuthError, authLinkClass } from './auth-card';
import { AuthTextField } from './auth-fields';
import { GoogleButton } from './google-button';
import { PASSWORD_MIN, PasswordField } from './password-field';

// Phase 18 Track A — /sign-up. The server answers the same for a new and an existing address
// (§5.3), so this screen always moves on to "check your email". Verification links land on
// /welcome (onboarding), signed in.

export function SignUpForm({ next, googleEnabled }: { next: string; googleEnabled: boolean }) {
  const t = useTranslations('auth.signUp');
  const router = useRouter();
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

  const legalLink = (href: string) =>
    function LegalLink(chunks: ReactNode) {
      return (
        <Link className={`${authLinkClass} underline`} href={href}>
          {chunks}
        </Link>
      );
    };

  return (
    <AuthCard
      title={t('title')}
      description={t('description')}
      footer={
        <Link className={authLinkClass} href={`/sign-in?next=${encodeURIComponent(next)}`}>
          {t('haveAccount')}
        </Link>
      }
    >
      <AuthError error={error} />
      <form onSubmit={(e) => void submit(e)} className="space-y-5">
        <AuthTextField
          label={t('name')}
          autoComplete="name"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
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
        <PasswordField
          label={t('password')}
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          showStrength
          error={error}
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
        <p className="text-xs leading-relaxed text-foreground-secondary">
          {t.rich('terms', {
            terms: legalLink('/legal/terms'),
            privacy: legalLink('/legal/privacy'),
          })}
        </p>
      </form>
      {googleEnabled && <GoogleButton next="/welcome" />}
    </AuthCard>
  );
}
