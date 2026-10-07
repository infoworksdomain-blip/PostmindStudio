'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Link2, Loader2, MessageSquare, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { NativeSelect } from '@/components/ui/native-select';
import { useFormat } from '@/lib/client/format';
import { Section, StateBadge } from '../primitives';

// BACKLOG 15.E5 / operator decision P8 — "Share for feedback" on the review screen. A link lets
// someone outside PostMind watch the variants and leave feedback; it can never approve (approval
// stays with signed-in members who hold the approve capability). The full URL is shown once,
// right after it is made (only a hash of its token is stored). Feedback appears here.
// Data: GET|POST /api/studio/projects/:id/share-links, DELETE …/:linkId.

export interface ShareComment {
  id: string;
  authorName: string;
  authorEmail: string | null;
  body: string;
  createdAt: string;
}

export interface ShareLinkItem {
  id: string;
  state: 'active' | 'expired' | 'revoked';
  expiresAt: string;
  createdAt: string;
  viewCount: number;
  comments: ShareComment[];
}

const STATE_TONE = {
  active: 'good',
  expired: 'neutral',
  revoked: 'bad',
} as const;

/** Link lifetimes offered, in hours (labels: share.links.expiryDays). */
export const EXPIRY_OPTIONS = [24, 72, 168] as const;

export function ShareLinksPanel({ projectId }: { projectId: string }) {
  const t = useTranslations('share.links');
  const tc = useTranslations('common.actions');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const path = `/projects/${encodeURIComponent(projectId)}/share-links`;
  const { data, mutate } = useApi<{ data: ShareLinkItem[] }>(path);
  const [hours, setHours] = useState(72);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    try {
      const res = await api<{ link: { url: string } }>(path, {
        method: 'POST',
        body: { expiresInHours: hours },
        idempotencyKey: newIdempotencyKey(),
      });
      setFresh(res.link.url);
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  const revoke = async (id: string) => {
    try {
      await api(`${path}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('revoked'));
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const links = data?.data ?? [];
  return (
    <Section
      title={t('title')}
      description={t('description')}
      actions={
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="share-expiry">
            {t('expiryLabel')}
          </label>
          <NativeSelect
            id="share-expiry"
            size="sm"
            wrapperClassName="w-auto"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            {EXPIRY_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {t('expiryDays', { count: h / 24 })}
              </option>
            ))}
          </NativeSelect>
          <Button size="sm" onClick={() => void create()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Link2 />}
            {t('create')}
          </Button>
        </div>
      }
    >
      {fresh && (
        <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
          <p className="font-medium">{t('copyNow')}</p>
          <div className="mt-2 flex items-center gap-2">
            <code
              dir="ltr"
              className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-xs"
            >
              {fresh}
            </code>
            <Button size="sm" variant="outline" onClick={() => void copy(fresh)}>
              <Copy /> {tc('copy')}
            </Button>
          </div>
        </div>
      )}
      {links.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul aria-label={t('listAria')} className="grid gap-3">
          {links.map((l) => (
            <li key={l.id} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  <StateBadge label={t(`states.${l.state}`)} tone={STATE_TONE[l.state]} />
                  <span className="text-muted-foreground">
                    {t(l.state === 'active' ? 'expiresMeta' : 'expiredMeta', {
                      date: f.date(l.expiresAt),
                      views: l.viewCount,
                    })}
                  </span>
                </span>
                {l.state === 'active' && (
                  <Button size="sm" variant="ghost" onClick={() => void revoke(l.id)}>
                    <XCircle /> {t('revoke')}
                  </Button>
                )}
              </div>
              {l.comments.length > 0 && (
                <ul aria-label={t('feedbackAria')} className="mt-3 grid gap-2">
                  {l.comments.map((c) => (
                    <li key={c.id} className="rounded-md bg-muted/50 p-2 text-sm">
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <MessageSquare className="size-3" />
                        <bdi className="font-medium text-foreground">{c.authorName}</bdi>
                        {c.authorEmail && (
                          <span>
                            · <bdi>{c.authorEmail}</bdi>
                          </span>
                        )}
                        <span>· {f.date(c.createdAt)}</span>
                      </p>
                      <p dir="auto" className="mt-1 break-words whitespace-pre-wrap">
                        {c.body}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
