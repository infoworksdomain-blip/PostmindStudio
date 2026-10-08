'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { KeyRound } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import type {
  ByocProviderOption,
  ProviderCredential,
  ProviderCredentialsResponse,
} from '@/lib/client/types';
import { StudioCapability } from '@/lib/rbac';
import { useCan } from '../use-can';

// P1 BYOC (operator decision 2026-09-28; spec 6.6 / 12.6): Enterprise organisations add their
// own provider API keys; Studio then calls those providers with the organisation's keys. Keys
// are write-only here: after saving only the last four characters (hint) are ever shown.
// 25.12: the list itself; Settings → Provider keys (provider-keys-screen.tsx) frames it.

/** Catalogue keys (account.providerKeys.unavailable.<key>) for why BYOC is unavailable. */
const UNAVAILABLE = { disabled: 'disabled', plan_tier: 'planTier' } as const;

type ProviderKeysT = ReturnType<typeof useTranslations<'account.providerKeys'>>;

function status(t: ProviderKeysT, credential: ProviderCredential | undefined): string {
  if (!credential || credential.state !== 'active') return t('status.studioKey');
  const result = credential.lastTestResult;
  const hint = credential.hint ?? '';
  if (!result) return t('status.notTested', { hint });
  return result.healthy
    ? t('status.working', { hint })
    : t('status.failed', { hint, reason: result.reason ?? t('status.unhealthy') });
}

function ProviderRow({
  provider,
  credential,
  onChanged,
}: {
  provider: ByocProviderOption;
  credential: ProviderCredential | undefined;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations('account.providerKeys');
  const errorMessage = useErrorMessage();
  const [apiKey, setApiKey] = useState('');
  const [secondaryKey, setSecondaryKey] = useState('');
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'remove'>(null);
  const active = credential?.state === 'active';
  const path = `/provider-credentials/${provider.id}`;

  async function run(kind: 'save' | 'test' | 'remove', action: () => Promise<void>) {
    setBusy(kind);
    try {
      await action();
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    void run('save', async () => {
      await api(path, {
        method: 'PUT',
        body: { apiKey, ...(provider.twoPart && { secondaryKey }) },
        idempotencyKey: newIdempotencyKey(),
      });
      setApiKey('');
      setSecondaryKey('');
      toast.success(t('toast.saved', { provider: provider.label }));
    });
  }

  const test = () =>
    run('test', async () => {
      const res = await api<{ healthy: boolean; reason?: string }>(`${path}/test`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      if (res.healthy) toast.success(t('toast.works', { provider: provider.label }));
      else
        toast.error(
          t('toast.failed', {
            provider: provider.label,
            reason: res.reason ?? t('status.unhealthy'),
          }),
        );
    });

  const remove = () =>
    run('remove', async () => {
      await api(path, { method: 'DELETE', idempotencyKey: newIdempotencyKey() });
      toast.success(t('toast.removed', { provider: provider.label }));
    });

  return (
    <li aria-label={provider.label} className="flex flex-col gap-3 border-b border-border py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{provider.label}</p>
          <p className="text-xs text-muted-foreground">{status(t, credential)}</p>
        </div>
        {active && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void test()}
            >
              {busy === 'test' ? t('testing') : t('test')}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => void remove()}
            >
              {t('remove')}
            </Button>
          </div>
        )}
      </div>
      <form className="flex flex-wrap items-center gap-2" onSubmit={save}>
        <Input
          type="password"
          autoComplete="off"
          aria-label={
            provider.twoPart
              ? t('publicKeyAria', { provider: provider.label })
              : t('apiKeyAria', { provider: provider.label })
          }
          placeholder={
            active
              ? t('placeholder.replace')
              : provider.twoPart
                ? t('placeholder.publicKey')
                : t('placeholder.apiKey')
          }
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="max-w-xs"
        />
        {provider.twoPart && (
          <Input
            type="password"
            autoComplete="off"
            aria-label={t('privateKeyAria', { provider: provider.label })}
            placeholder={t('placeholder.privateKey')}
            value={secondaryKey}
            onChange={(e) => setSecondaryKey(e.target.value)}
            className="max-w-xs"
          />
        )}
        <Button
          size="sm"
          type="submit"
          disabled={
            busy !== null ||
            apiKey.trim().length < 8 ||
            (provider.twoPart && secondaryKey.trim().length < 8)
          }
        >
          {busy === 'save' ? t('saving') : active ? t('replace') : t('save')}
        </Button>
      </form>
    </li>
  );
}

export function ByocKeysPanel() {
  const t = useTranslations('account.providerKeys');
  const errorMessage = useErrorMessage();
  // Members without the connections capability do not manage provider keys: no panel, and no
  // request that can only answer 403 (it showed up as an error in every viewer's console). Until
  // /me says what the member may do, nothing is requested.
  const mayManage = useCan(StudioCapability.ConnectionsManage, false);
  const { data, error, isLoading, mutate } = useApi<ProviderCredentialsResponse>(
    mayManage ? '/provider-credentials' : null,
  );
  if (!mayManage || (error instanceof ApiError && error.status === 403)) return null;

  return (
    <div data-slot="provider-keys" className="grid gap-4">
      {error && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <p>{t('loadFailed', { reason: errorMessage(error) })}</p>
          <Button size="sm" variant="outline" onClick={() => void mutate()}>
            {t('retry')}
          </Button>
        </div>
      )}
      {isLoading && <Skeleton className="h-24 rounded-xl" aria-label={t('loading')} />}
      {data && !data.enabled && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t(`unavailable.${UNAVAILABLE[data.reason ?? 'disabled']}`)}
        </p>
      )}
      {data?.enabled && (
        <ul aria-label={t('title')} className="border-t border-border">
          {data.providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              credential={data.credentials.find((c) => c.providerId === provider.id)}
              onChanged={() => mutate()}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
