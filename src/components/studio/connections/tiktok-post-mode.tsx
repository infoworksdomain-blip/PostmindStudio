'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { TriangleAlert } from 'lucide-react';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import type { PlatformConnection } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { belongsToBusiness } from './platforms';

// 22.7 — a TikTok connection's posting preference: post directly, or send to the creator's TikTok
// drafts (Fastlane's default: they add a trending sound in the app and publish). New connections
// default to drafts; connections from before 22.7 keep posting directly (tiktokPostMode null).
// Drafts need TikTok's video.upload permission: without it Studio posts directly and asks for a
// reconnect here, so nothing fails silently.

export type TikTokPostMode = 'direct' | 'drafts';
const MODES: readonly TikTokPostMode[] = ['drafts', 'direct'];
const UPLOAD_SCOPE = 'video.upload';

export function postModeOf(connection: Pick<PlatformConnection, 'tiktokPostMode'>): TikTokPostMode {
  return connection.tiktokPostMode === 'drafts' ? 'drafts' : 'direct';
}

/** Drafts are possible when the connection granted video.upload. */
export function uploadGranted(connection: Pick<PlatformConnection, 'scopes'>): boolean {
  return connection.scopes.includes(UPLOAD_SCOPE);
}

export function TikTokPostModeSetting({
  connection,
  onChanged,
}: {
  connection: PlatformConnection;
  onChanged: () => void | Promise<unknown>;
}) {
  const t = useTranslations('connections.tiktokPostMode');
  const errorMessage = useErrorMessage();
  const name = useId();
  const [saving, setSaving] = useState(false);
  const current = postModeOf(connection);

  async function choose(mode: TikTokPostMode) {
    if (mode === current || saving) return;
    setSaving(true);
    try {
      await api(`/platform-connections/${connection.id}`, {
        method: 'PATCH',
        body: { tiktokPostMode: mode },
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('saved'));
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <fieldset className="mt-3 max-w-md" disabled={saving}>
      <legend className="text-xs font-medium text-muted-foreground">
        {t('legend', { account: connection.platformAccountName })}
      </legend>
      <div className="mt-1.5 grid gap-1.5">
        {MODES.map((mode) => (
          <label
            key={mode}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              current === mode
                ? 'border-primary bg-primary/6'
                : 'border-border hover:bg-secondary/60',
            )}
          >
            <input
              type="radio"
              name={name}
              value={mode}
              checked={current === mode}
              onChange={() => void choose(mode)}
              className="mt-1 accent-primary"
            />
            <span>
              <span className="block font-medium">{t(mode)}</span>
              <span className="block text-xs text-muted-foreground">{t(`${mode}Hint`)}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{t('note')}</p>
      {current === 'drafts' && !uploadGranted(connection) && (
        <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t('reconnect')}
        </p>
      )}
    </fieldset>
  );
}

/**
 * "Goes to your TikTok drafts" for screens that publish to TikTok (Blitz keep, the autopilot
 * wizard). Shown when the business's active TikTok account sends drafts; nothing otherwise.
 */
export function TikTokDraftsHint({
  businessId,
  className,
}: {
  businessId: string | null;
  className?: string;
}) {
  const t = useTranslations('connections.tiktokPostMode');
  const { data } = useApi<{ data: PlatformConnection[] }>('/platform-connections');
  const tiktok = (data?.data ?? []).find(
    (c) => c.platform === 'tiktok' && c.state === 'active' && belongsToBusiness(c, businessId),
  );
  if (!tiktok || postModeOf(tiktok) !== 'drafts') return null;
  const reconnect = !uploadGranted(tiktok);
  return (
    <p className={cn('text-xs text-muted-foreground', className)} role="note">
      {reconnect ? t('reconnect') : t('goesToDrafts')}
    </p>
  );
}
