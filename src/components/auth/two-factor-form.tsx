'use client';

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authApi } from '@/lib/client/auth';
import { AuthCard, AuthError } from './auth-card';

// Phase 18 §5.6 — /two-factor: the second step after the password when 2FA is on. A 6-digit code
// from the authenticator app, or one of the 10 single-use backup codes. The pending sign-in lives
// in Better Auth's short-lived two-factor cookie; success sets a fresh session cookie.

export function TwoFactorForm({ next }: { next: string }) {
  const t = useTranslations('auth.twoFactor');
  const codeId = useId();
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
      window.location.assign(next);
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

  return (
    <AuthCard
      title={t('title')}
      description={mode === 'totp' ? t('totpDescription') : t('backupDescription')}
      footer={
        <Link className="underline-offset-4 hover:underline" href="/sign-in">
          {t('startOver')}
        </Link>
      }
    >
      <AuthError error={error} />
      <form onSubmit={(e) => void submit(e)} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor={codeId}>{mode === 'totp' ? t('totpLabel') : t('backupLabel')}</Label>
          <Input
            id={codeId}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoComplete="one-time-code"
            inputMode={mode === 'totp' ? 'numeric' : 'text'}
            pattern={mode === 'totp' ? '[0-9 ]{6,7}' : undefined}
            maxLength={mode === 'totp' ? 7 : 16}
            className="h-12 text-center font-mono text-xl tracking-[0.3em]"
          />
        </div>
        {mode === 'totp' && (
          <div className="flex items-center gap-2">
            <Checkbox id={trustId} checked={trust} onCheckedChange={(v) => setTrust(v === true)} />
            <Label htmlFor={trustId} className="font-normal">
              {t('trustDevice')}
            </Label>
          </div>
        )}
        <Button type="submit" className="h-10 w-full" disabled={busy || code.trim() === ''}>
          {busy && <Loader2 className="animate-spin" />}
          {t('submit')}
        </Button>
      </form>
      <Button type="button" variant="link" className="mt-4 px-0" onClick={switchMode}>
        {mode === 'totp' ? t('useBackup') : t('useTotp')}
      </Button>
    </AuthCard>
  );
}
