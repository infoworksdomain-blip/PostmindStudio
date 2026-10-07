'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AuthError } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { authErrorKey, authFetch } from '@/lib/client/auth';
import { hardNavigate } from '@/lib/client/navigate';
import { Section, StateBadge } from '../../primitives';

// Phase 18 §2.9 — linked Google account. Linking needs Google to report a verified email that
// matches this account's (Better Auth: allowDifferentEmails false).

interface LinkedAccount {
  providerId: string;
}

export function SignInMethodsSection({ googleEnabled }: { googleEnabled: boolean }) {
  const t = useTranslations('security.methods');
  const tErr = useTranslations('auth.errors');
  const [accounts, setAccounts] = useState<LinkedAccount[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const load = useCallback(
    () =>
      authFetch<LinkedAccount[]>('/list-accounts')
        .then(setAccounts)
        .catch((err: unknown) => setError(err)),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const google = accounts?.some((a) => a.providerId === 'google') ?? false;
  const hasPassword = accounts?.some((a) => a.providerId === 'credential') ?? false;

  const link = async () => {
    setBusy(true);
    try {
      const { url } = await authFetch<{ url?: string }>('/link-social', {
        body: { provider: 'google', callbackURL: '/account/security' },
      });
      if (!url || !hardNavigate(url)) setBusy(false);
    } catch (err) {
      toast.error(tErr(authErrorKey(err)));
      setBusy(false);
    }
  };

  const unlink = async () => {
    setBusy(true);
    try {
      await authFetch('/unlink-account', { body: { providerId: 'google' } });
      toast.success(t('unlinked'));
      await load();
    } catch (err) {
      toast.error(tErr(authErrorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t('title')} description={t('description')}>
      <AuthError error={error} />
      <ul className="divide-y divide-border">
        <li className="flex items-center justify-between gap-3 py-3">
          <span className="text-sm">{t('password')}</span>
          <StateBadge
            label={hasPassword ? t('on') : t('off')}
            tone={hasPassword ? 'good' : 'neutral'}
          />
        </li>
        {googleEnabled && (
          <li className="flex items-center justify-between gap-3 py-3">
            <span className="text-sm">Google</span>
            {accounts === null ? null : google ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void unlink()}
                disabled={!hasPassword}
                title={hasPassword ? undefined : t('unlinkNeedsPassword')}
                loading={busy}
              >
                {t('unlink')}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => void link()} loading={busy}>
                {t('link')}
              </Button>
            )}
          </li>
        )}
      </ul>
    </Section>
  );
}
