'use client';

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { authApi } from '@/lib/client/auth';
import { hardNavigate } from '@/lib/client/navigate';
import { AuthCard, AuthError, authLinkClass } from './auth-card';
import { AuthTextField } from './auth-fields';

// Phase 18 §5.6 — /two-factor: the second step after the password when 2FA is on. A 6-digit code
// from the authenticator app, or one of the 10 single-use backup codes. The pending sign-in lives
// in Better Auth's short-lived two-factor cookie; success sets a fresh session cookie.
// 25.6: one code input (inputmode numeric, autocomplete one-time-code so phones offer the code),
// a wrong code shown under it, and the switch to a backup code as a quiet secondary action.

export function TwoFactorForm({ next }: { next: string }) {
  const t = useTranslations('auth.twoFactor');
  const trustId = useId();
  const [mode, setMode] = useState<'totp' | 'backup'>('totp');
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (mode === 'totp') await authApi.verifyTotp(code.replace(/\s/g, ''), trust);
      else await authApi.verifyBackupCode(code.trim());
      hardNavigate(next);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  const switchMode = () => {
    setMode((m) => (m === 'totp' ? 'backup' : 'totp'));
    setCode('');
    setError(undefined);
  };

  const totp = mode === 'totp';
  return (
    <AuthCard
      title={t('title')}
      description={totp ? t('totpDescription') : t('backupDescription')}
      footer={
        <Link className={authLinkClass} href="/sign-in">
          {t('startOver')}
        </Link>
      }
    >
      <AuthError error={error} />
      <form onSubmit={(e) => void submit(e)} className="space-y-5">
        <AuthTextField
          // A fresh input per mode: the browser's one-time-code suggestion and the pattern reset.
          key={mode}
          label={totp ? t('totpLabel') : t('backupLabel')}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          autoFocus
          autoComplete="one-time-code"
          inputMode={totp ? 'numeric' : 'text'}
          autoCapitalize="off"
          spellCheck={false}
          pattern={totp ? '[0-9 ]{6,7}' : undefined}
          maxLength={totp ? 7 : 16}
          dir="ltr"
          className="h-12 text-center font-mono text-xl tracking-[0.3em]"
          error={error}
          field="code"
        />
        {totp && (
          <div className="flex items-center gap-2.5">
            <Checkbox id={trustId} checked={trust} onCheckedChange={(v) => setTrust(v === true)} />
            <Label htmlFor={trustId} className="font-normal text-foreground-secondary">
              {t('trustDevice')}
            </Label>
          </div>
        )}
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={code.trim() === ''}
          loading={busy}
        >
          {t('submit')}
        </Button>
      </form>
      <Button
        type="button"
        variant="link"
        className="mt-5 text-[0.8125rem] text-foreground-secondary hover:text-foreground"
        onClick={switchMode}
      >
        {totp ? t('useBackup') : t('useTotp')}
      </Button>
    </AuthCard>
  );
}
