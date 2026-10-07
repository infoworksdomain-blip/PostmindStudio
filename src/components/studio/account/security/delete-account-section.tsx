'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PasswordField } from '@/components/auth/password-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { ApiError, api, useErrorMessage } from '@/lib/client/api';
import { authFetch } from '@/lib/client/auth';
import { hardNavigate } from '@/lib/client/navigate';
import { DangerRow, DangerZone } from '../../settings/danger-zone';

// Phase 18 §5.11 — delete my account. Re-authenticate with the password (Google-only accounts:
// a recent sign-in). An organisation where this user is the only owner but others are members
// blocks it (409 sole_owner): ownership has to move first. 25.12: the page's danger zone; the
// password and the "I understand" tick are asked in the confirmation, which stays open to explain
// a refusal.

export function DeleteAccountSection() {
  const t = useTranslations('security.deleteAccount');
  const tn = useTranslations('settingsNav');
  const [hasPassword, setHasPassword] = useState(true);
  useEffect(() => {
    void authFetch<Array<{ providerId: string }>>('/list-accounts')
      .then((accounts) => setHasPassword(accounts.some((a) => a.providerId === 'credential')))
      .catch(() => setHasPassword(true));
  }, []);
  const errorMessage = useErrorMessage();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);

  const reset = () => {
    setPassword('');
    setConfirmed(false);
    setError(null);
    setBlocked([]);
  };

  const remove = async (): Promise<boolean> => {
    setError(null);
    setBlocked([]);
    try {
      await api('/account/delete', {
        method: 'POST',
        body: hasPassword ? { password } : {},
      });
      hardNavigate('/sign-in');
      return true;
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
      return false;
    }
  };

  return (
    <DangerZone id="delete-account" title={tn('dangerZone')}>
      <DangerRow
        title={t('title')}
        description={t('description')}
        action={
          <Button variant="destructive" onClick={() => setOpen(true)}>
            {t('submit')}
          </Button>
        }
      />
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title={t('title')}
        description={t('consequences')}
        confirmLabel={t('submit')}
        confirmDisabled={!confirmed || (hasPassword && !password)}
        onConfirm={remove}
      >
        <div className="grid gap-4">
          {blocked.length > 0 && (
            <Alert variant="destructive">
              <AlertDescription>
                {t('soleOwner', { organisations: blocked.join(', ') })}
              </AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
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
        </div>
      </ConfirmDialog>
    </DangerZone>
  );
}
