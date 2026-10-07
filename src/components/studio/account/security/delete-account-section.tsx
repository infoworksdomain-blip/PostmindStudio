'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { PasswordField } from '@/components/auth/password-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ApiError, api, useErrorMessage } from '@/lib/client/api';
import { authFetch } from '@/lib/client/auth';
import { hardNavigate } from '@/lib/client/navigate';
import { Section } from '../../primitives';

// Phase 18 §5.11 — delete my account. Re-authenticate with the password (Google-only accounts:
// a recent sign-in). An organisation where this user is the only owner but others are members
// blocks it (409 sole_owner): ownership has to move first.

export function DeleteAccountSection() {
  const t = useTranslations('security.deleteAccount');
  const [hasPassword, setHasPassword] = useState(true);
  useEffect(() => {
    void authFetch<Array<{ providerId: string }>>('/list-accounts')
      .then((accounts) => setHasPassword(accounts.some((a) => a.providerId === 'credential')))
      .catch(() => setHasPassword(true));
  }, []);
  const errorMessage = useErrorMessage();
  const [password, setPassword] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setBlocked([]);
    try {
      await api('/account/delete', {
        method: 'POST',
        body: hasPassword ? { password } : {},
      });
      hardNavigate('/sign-in');
    } catch (err) {
      if (err instanceof ApiError && err.details?.reason === 'sole_owner') {
        const orgs = (err.details.organisations as Array<{ name: string }> | undefined) ?? [];
        setBlocked(orgs.map((o) => o.name));
      } else if (err instanceof ApiError && err.details?.reason === 'reauth_failed') {
        setError(t('wrongPassword'));
      } else if (err instanceof ApiError && err.details?.reason === 'reauth_required') {
        setError(t('signInAgain'));
      } else {
        setError(errorMessage(err));
      }
      setBusy(false);
    }
  };

  return (
    <Section title={t('title')} description={t('description')} className="border-destructive/40">
      {blocked.length > 0 && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            {t('soleOwner', { organisations: blocked.join(', ') })}
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <form onSubmit={(e) => void submit(e)} className="grid max-w-md gap-4">
        <p className="text-sm">{t('consequences')}</p>
        {hasPassword && (
          <PasswordField
            label={t('password')}
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
        )}
        <div className="flex items-start gap-2">
          <Checkbox
            id="delete-account-confirm"
            checked={confirmed}
            onCheckedChange={(v) => setConfirmed(v === true)}
          />
          <Label htmlFor="delete-account-confirm" className="font-normal">
            {t('confirm')}
          </Label>
        </div>
        <Button
          type="submit"
          variant="destructive"
          className="justify-self-start"
          disabled={!confirmed || (hasPassword && !password)}
          loading={busy}
        >
          {t('submit')}
        </Button>
      </form>
    </Section>
  );
}
