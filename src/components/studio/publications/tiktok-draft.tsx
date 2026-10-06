'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useFormat, type Tone } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';

// 22.7 — a TikTok post sent to the creator's TikTok inbox (the connection chose "Send to TikTok
// drafts", or the 15.A2 fallback) is stored PUBLISHED by the worker but is not live: the creator
// finishes it in the TikTok app. Screens show "Sent to TikTok drafts" instead of "Live", with the
// reminder to add a sound and keep the AI-generated content label on (the inbox upload cannot set
// is_aigc). A drafts choice that fell back to a direct post (no video.upload) says "Reconnect".

export type TikTokInboxKind = 'drafts' | 'inbox';

/** 'drafts' (chosen), 'inbox' (15.A2 fallback) or null when the post was not sent to TikTok's inbox. */
export function tiktokInboxKind(p: Pick<Publication, 'metadata'>): TikTokInboxKind | null {
  const meta = p.metadata;
  if (!meta || meta.tiktokMode !== 'inbox') return null;
  return meta.inboxReason === 'drafts' ? 'drafts' : 'inbox';
}

/** True when drafts were chosen but the connection lacked video.upload (posted directly). */
export function draftsFellBack(p: Pick<Publication, 'metadata'>): boolean {
  return typeof p.metadata?.draftsUnavailable === 'string';
}

/** The state badge for a publication, with "Sent to TikTok drafts" for inbox uploads. */
export function usePublicationBadge(): (p: Pick<Publication, 'state' | 'metadata'>) => {
  label: string;
  tone: Tone;
} {
  const t = useTranslations('publications.tiktokDrafts');
  const f = useFormat();
  return useCallback(
    (p) =>
      p.state === 'PUBLISHED' && tiktokInboxKind(p)
        ? { label: t('badge'), tone: 'warn' }
        : f.publicationState(p.state),
    [t, f],
  );
}

/** The localised "finish it in the TikTok app" / "reconnect to send drafts" line, or nothing. */
export function TikTokPublicationNote({
  publication,
  className = 'mt-1 block text-xs text-muted-foreground',
}: {
  publication: Pick<Publication, 'metadata'>;
  className?: string;
}) {
  const t = useTranslations('publications.tiktokDrafts');
  const kind = tiktokInboxKind(publication);
  if (kind)
    return <span className={className}>{t(kind === 'drafts' ? 'draftsNote' : 'inboxNote')}</span>;
  if (draftsFellBack(publication)) return <span className={className}>{t('reconnectNote')}</span>;
  return null;
}
