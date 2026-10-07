'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { MailCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { authApi } from '@/lib/client/auth';
import {
  AuthCard,
  AuthError,
  authLinkClass,
  AuthNotice,
  AuthStatusMark,
  SupportContact,
} from './auth-card';
import { AuthTextField } from './auth-fields';

// Phase 18 §5.5 — /verify-email: "check your inbox" after sign-up (or an unverified sign-in), and
// the landing page for an expired or invalid link (?error=). Resending always says the same thing.
// 25.6: the inbox state leads with where the link went and what to do; a bad link says so calmly
// and makes "send a new link" the one primary action.

export function VerifyEmailScreen({
  email: initialEmail,
  error,
  supportEmail,
}: {
  email?: string;
  error?: string;
  supportEmail?: string;
}) {
  const t = useTranslations('auth.verify');
  const [email, setEmail] = useState(initialEmail ?? '');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  const resend = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(undefined);
    try {
      await authApi.resendVerification(email, '/welcome');
      setSent(true);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      icon={
        error ? (
          <AuthStatusMark tone="problem" />
        ) : (
          <span
            aria-hidden
            className="grid size-10 place-items-center rounded-full bg-surface-raised text-foreground"
          >
            <MailCheck className="size-5" strokeWidth={1.75} />
          </span>
        )
      }
      title={error ? t('invalidTitle') : t('title')}
      description={error ? t('invalidDescription') : t('description')}
      footer={
        <Link className={authLinkClass} href="/sign-in">
          {t('backToSignIn')}
        </Link>
      }
    >
      {!error && (
        <p className="mb-6 rounded-field bg-surface-raised px-3.5 py-3 text-sm leading-relaxed">
          {initialEmail ? t('sentTo', { email: initialEmail }) : t('sentGeneric')}
        </p>
      )}
      {sent && <AuthNotice>{t('resent')}</AuthNotice>}
      <AuthError error={failure} />
      <form onSubmit={(e) => void resend(e)} className="space-y-4">
        {!error && <p className="text-sm text-foreground-secondary">{t('resendPrompt')}</p>}
        <AuthTextField
          label={t('email')}
          type="email"
          autoComplete="email"
          inputMode="email"
          spellCheck={false}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={failure}
          field="email"
        />
        <Button
          type="submit"
          // A bad link: sending a new one is the next step. Otherwise the inbox is.
          variant={error ? 'default' : 'outline'}
          size="lg"
          className="w-full"
          loading={busy}
        >
          {t('resend')}
        </Button>
      </form>
      <SupportContact email={supportEmail} />
    </AuthCard>
  );
}
