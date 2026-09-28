'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import type {
  ByocProviderOption,
  ProviderCredential,
  ProviderCredentialsResponse,
} from '@/lib/client/types';
import { Section } from '../primitives';

// P1 BYOC (operator decision 2026-09-28; spec 6.6 / 12.6): Enterprise organisations add their
// own provider API keys; Studio then calls those providers with the organisation's keys. Keys
// are write-only here: after saving only the last four characters (hint) are ever shown.

const UNAVAILABLE: Record<'disabled' | 'plan_tier', string> = {
  disabled: 'Bring-your-own provider keys are not switched on for Studio yet.',
  plan_tier:
    'Bring-your-own provider keys are an Enterprise feature. Upgrade to use your own provider accounts.',
};

function status(credential: ProviderCredential | undefined): string {
  if (!credential || credential.state !== 'active') return 'Using Studio’s key';
  const result = credential.lastTestResult;
  const hint = `Your key ••••${credential.hint ?? ''}`;
  if (!result) return `${hint} · not tested`;
  return result.healthy ? `${hint} · working` : `${hint} · failed: ${result.reason ?? 'unhealthy'}`;
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
      toast.success(`${provider.label} key saved`);
    });
  }

  const test = () =>
    run('test', async () => {
      const res = await api<{ healthy: boolean; reason?: string }>(`${path}/test`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      if (res.healthy) toast.success(`${provider.label} key works`);
      else toast.error(`${provider.label} key failed: ${res.reason ?? 'unhealthy'}`);
    });

  const remove = () =>
    run('remove', async () => {
      await api(path, { method: 'DELETE', idempotencyKey: newIdempotencyKey() });
      toast.success(`${provider.label} key removed; Studio’s key is used again`);
    });

  return (
    <li
      aria-label={provider.label}
      className="flex flex-col gap-2 border-b border-border/70 py-3 last:border-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{provider.label}</p>
          <p className="text-xs text-muted-foreground">{status(credential)}</p>
        </div>
        {active && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void test()}
            >
              {busy === 'test' ? 'Testing…' : 'Test'}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => void remove()}
            >
              Remove
            </Button>
          </div>
        )}
      </div>
      <form className="flex flex-wrap items-center gap-2" onSubmit={save}>
        <Input
          type="password"
          autoComplete="off"
          aria-label={
            provider.twoPart ? `${provider.label} public key` : `${provider.label} API key`
          }
          placeholder={active ? 'Replace key' : provider.twoPart ? 'Public key' : 'API key'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="max-w-xs"
        />
        {provider.twoPart && (
          <Input
            type="password"
            autoComplete="off"
            aria-label={`${provider.label} private key`}
            placeholder="Private key"
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
          {busy === 'save' ? 'Saving…' : active ? 'Replace' : 'Save'}
        </Button>
      </form>
    </li>
  );
}

export function ByocKeysPanel() {
  const { data, error, isLoading, mutate } =
    useApi<ProviderCredentialsResponse>('/provider-credentials');
  // Members without the connections capability (403) do not manage provider keys: no panel.
  if (error instanceof ApiError && error.status === 403) return null;

  return (
    <Section
      className="mt-8"
      title="Provider keys (BYOC)"
      description="Use your own AI provider accounts. Studio never shows a saved key again; only its last four characters."
    >
      {error && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <p>Couldn’t load provider keys: {errorMessage(error)}</p>
          <Button size="sm" variant="outline" onClick={() => void mutate()}>
            Retry
          </Button>
        </div>
      )}
      {isLoading && <Skeleton className="h-24 rounded-xl" aria-label="Loading provider keys" />}
      {data && !data.enabled && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <KeyRound className="mt-0.5 size-4 shrink-0" />
          {UNAVAILABLE[data.reason ?? 'disabled']}
        </p>
      )}
      {data?.enabled && (
        <ul>
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
    </Section>
  );
}
