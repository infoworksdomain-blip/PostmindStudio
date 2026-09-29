'use client';

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { Loader2, MailCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authApi } from '@/lib/client/auth';
import { AuthCard, AuthError, AuthNotice, SupportContact } from './auth-card';

// Phase 18 §5.5 — /verify-email: "check your inbox" after sign-up (or an unverified sign-in), and
// the landing page for an expired or invalid link (?error=). Resending always says the same thing.

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
  const emailId = useId();
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
      title={error ? t('invalidTitle') : t('title')}
      description={error ? t('invalidDescription') : t('description')}
      footer={
        <Link className="underline-offset-4 hover:underline" href="/sign-in">
          {t('backToSignIn')}
        </Link>
      }
    >
      {!error && (
        <div className="mb-6 flex items-center gap-3 text-sm">
          <MailCheck className="size-5 text-primary" aria-hidden="true" />
          <span>{initialEmail ? t('sentTo', { email: initialEmail }) : t('sentGeneric')}</span>
        </div>
      )}
      {sent && <AuthNotice>{t('resent')}</AuthNotice>}
      <AuthError error={failure} />
      <form onSubmit={(e) => void resend(e)} className="space-y-4">
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
        <Button type="submit" variant="outline" className="h-10 w-full" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {t('resend')}
        </Button>
      </form>
      <SupportContact email={supportEmail} />
    </AuthCard>
  );
}
