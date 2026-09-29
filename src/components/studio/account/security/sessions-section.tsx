'use client';

import { useState } from 'react';
import { Loader2, Monitor } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { ErrorState, Section, StateBadge } from '../../primitives';

// Phase 18 §5.4 — where you are signed in, with revoke. Data: /api/studio/account/sessions
// (no tokens reach the browser).

interface SessionRow {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

function browserOf(ua: string): string | null {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return null;
}

function osOf(ua: string): string | null {
  if (/Windows/.test(ua)) return 'Windows';
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Linux/.test(ua)) return 'Linux';
  return null;
}

/** A short device label from the user agent (browser on OS), or null. */
export function deviceLabel(ua: string | null): { browser: string; os: string } | null {
  if (!ua) return null;
  const browser = browserOf(ua);
  const os = osOf(ua);
  return browser && os ? { browser, os } : null;
}

export function SessionsSection() {
  const t = useTranslations('security.sessions');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const { data, error, isLoading, mutate } = useApi<{ sessions: SessionRow[] }>(
    '/account/sessions',
  );
  const [busy, setBusy] = useState<string | null>(null);

  const revoke = async (id: string) => {
    setBusy(id);
    try {
      const path =
        id === 'others' ? '/account/sessions' : `/account/sessions/${encodeURIComponent(id)}`;
      await api(path, { method: 'DELETE' });
      toast.success(t('revoked'));
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const others = data?.sessions.filter((s) => !s.current).length ?? 0;
  return (
    <Section
      title={t('title')}
      description={t('description')}
      actions={
        others > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void revoke('others')}
            disabled={busy !== null}
          >
            {busy === 'others' && <Loader2 className="animate-spin" />}
            {t('revokeOthers')}
          </Button>
        )
      }
    >
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : (
        <ul className="divide-y divide-border">
          {data?.sessions.map((s) => {
            const device = deviceLabel(s.userAgent);
            const name = device ? t('device', device) : t('unknownDevice');
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
                <Monitor className="size-4 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('lastActive', { when: f.relative(s.lastActiveAt) })}
                  </p>
                  {s.ipAddress && (
                    <p className="text-xs text-muted-foreground" dir="ltr">
                      {s.ipAddress}
                    </p>
                  )}
                </div>
                {s.current ? (
                  <StateBadge label={t('current')} tone="live" />
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void revoke(s.id)}
                    disabled={busy !== null}
                    aria-label={t('revokeAria', { device: name })}
                  >
                    {busy === s.id && <Loader2 className="animate-spin" />}
                    {t('revoke')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
