'use client';

import { useState, type FormEvent } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AuthError } from '@/components/auth/auth-card';
import { PasswordField } from '@/components/auth/password-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authFetch } from '@/lib/client/auth';
import { Section, StateBadge } from '../../primitives';
import { QrCode } from './qr-code';

// Phase 18 §5.6 — TOTP two-factor: enrol (QR + manual key, confirm with a code), 10 single-use
// backup codes, regenerate, disable (password; the server then signs out other sessions).
// Staff need it for admin tools (§2.5).

type Step =
  | { kind: 'idle' }
  | { kind: 'enrol'; totpURI: string; backupCodes: string[] }
  | { kind: 'codes'; backupCodes: string[] };

function secretOf(uri: string): string {
  try {
    return new URL(uri).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
}

function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useTranslations('security.twoFactor');
  return (
    <div className="space-y-3">
      <p className="text-sm">{t('backupIntro')}</p>
      <ul className="grid grid-cols-2 gap-2 font-mono text-sm" aria-label={t('backupListLabel')}>
        {codes.map((c) => (
          <li key={c} className="rounded-md bg-muted px-3 py-1.5 text-center" dir="ltr">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(codes.join('\n'))
              .then(() => toast.success(t('copied')))
          }
        >
          {t('copy')}
        </Button>
        <Button type="button" onClick={onDone}>
          {t('saved')}
        </Button>
      </div>
    </div>
  );
}

export function TwoFactorSection({
  enabled,
  onChanged,
}: {
  enabled: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('security.twoFactor');
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const start = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const res = await authFetch<{ totpURI: string; backupCodes: string[] }>(
        '/two-factor/enable',
        { body: { password } },
      );
      setPassword('');
      setStep({ kind: 'enrol', totpURI: res.totpURI, backupCodes: res.backupCodes });
    });
  };

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    if (step.kind !== 'enrol') return;
    void run(async () => {
      await authFetch('/two-factor/verify-totp', { body: { code: code.replace(/\s/g, '') } });
      setCode('');
      setStep({ kind: 'codes', backupCodes: step.backupCodes });
      toast.success(t('enabled'));
      onChanged();
    });
  };

  const disable = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      // §5.6: turning 2FA off needs the password AND a current code or a backup code.
      await authFetch('/two-factor/disable', {
        body: { password, code: code.replace(/\s/g, '') },
      });
      setPassword('');
      setCode('');
      toast.success(t('disabled'));
      onChanged();
    });
  };

  const regenerate = () =>
    void run(async () => {
      const res = await authFetch<{ backupCodes: string[] }>('/two-factor/generate-backup-codes', {
        body: { password },
      });
      setPassword('');
      setStep({ kind: 'codes', backupCodes: res.backupCodes });
    });

  return (
    <Section
      title={t('title')}
      description={t('description')}
      actions={
        <StateBadge
          label={enabled ? t('statusOn') : t('statusOff')}
          tone={enabled ? 'good' : 'neutral'}
        />
      }
    >
      <AuthError error={error} />
      {step.kind === 'codes' ? (
        <BackupCodes codes={step.backupCodes} onDone={() => setStep({ kind: 'idle' })} />
      ) : step.kind === 'enrol' ? (
        <form onSubmit={confirm} className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
          <QrCode value={step.totpURI} label={t('qrLabel')} />
          <div className="space-y-3">
            <p className="text-sm">{t('scan')}</p>
            <p className="text-xs text-muted-foreground">{t('manual')}</p>
            <code
              className="block rounded-md bg-muted px-3 py-2 font-mono text-sm break-all"
              dir="ltr"
            >
              {secretOf(step.totpURI)}
            </code>
            <div className="space-y-2">
              <Label htmlFor="totp-confirm">{t('codeLabel')}</Label>
              <Input
                id="totp-confirm"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                className="h-10 max-w-40 font-mono tracking-[0.3em]"
              />
            </div>
            <Button type="submit" disabled={busy || code.trim().length < 6}>
              {busy && <Loader2 className="animate-spin" />}
              {t('confirm')}
            </Button>
          </div>
        </form>
      ) : enabled ? (
        <form onSubmit={disable} className="grid max-w-md gap-4">
          <p className="flex items-center gap-2 text-sm">
            <ShieldCheck className="size-4 text-success" aria-hidden="true" />
            {t('onExplainer')}
          </p>
          <PasswordField
            label={t('password')}
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          <div className="space-y-2">
            <Label htmlFor="totp-disable">{t('disableCodeLabel')}</Label>
            <Input
              id="totp-disable"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              maxLength={32}
              className="h-10 max-w-56 font-mono"
              dir="ltr"
              aria-describedby="totp-disable-hint"
            />
            <p id="totp-disable-hint" className="text-xs text-muted-foreground">
              {t('disableCodeHint')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy || !password}
              onClick={regenerate}
            >
              {t('regenerate')}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={busy || !password || code.trim().length < 6}
            >
              {busy && <Loader2 className="animate-spin" />}
              {t('disable')}
            </Button>
          </div>
        </form>
      ) : (
        <form onSubmit={start} className="grid max-w-md gap-4">
          <p className="text-sm">{t('offExplainer')}</p>
          <PasswordField
            label={t('password')}
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          <Button type="submit" className="justify-self-start" disabled={busy || !password}>
            {busy && <Loader2 className="animate-spin" />}
            {t('enable')}
          </Button>
        </form>
      )}
    </Section>
  );
}
