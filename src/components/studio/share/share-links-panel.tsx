'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Link2, Loader2, MessageSquare, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import { formatDate } from '@/lib/client/format';
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
  active: { label: 'Active', tone: 'good' },
  expired: { label: 'Expired', tone: 'neutral' },
  revoked: { label: 'Revoked', tone: 'bad' },
} as const;

export const EXPIRY_OPTIONS = [
  { hours: 24, label: '1 day' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
];

export function ShareLinksPanel({ projectId }: { projectId: string }) {
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
      toast.success('Link copied');
    } catch {
      toast.error('Copy failed — select the link and copy it yourself');
    }
  };

  const revoke = async (id: string) => {
    try {
      await api(`${path}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success('Link revoked');
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const links = data?.data ?? [];
  return (
    <Section
      title="Share for feedback"
      description="Anyone with the link can watch the variants and leave feedback. They cannot approve."
      actions={
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="share-expiry">
            Link lasts
          </label>
          <select
            id="share-expiry"
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.hours} value={o.hours}>
                {o.label}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={() => void create()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Link2 />}
            Create link
          </Button>
        </div>
      }
    >
      {fresh && (
        <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
          <p className="font-medium">Copy this link now — it is shown only once.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-xs">
              {fresh}
            </code>
            <Button size="sm" variant="outline" onClick={() => void copy(fresh)}>
              <Copy /> Copy
            </Button>
          </div>
        </div>
      )}
      {links.length === 0 ? (
        <p className="text-sm text-muted-foreground">No share links yet.</p>
      ) : (
        <ul aria-label="Share links" className="grid gap-3">
          {links.map((l) => (
            <li key={l.id} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  <StateBadge {...STATE_TONE[l.state]} />
                  <span className="text-muted-foreground">
                    {l.state === 'active' ? 'Expires' : 'Expired'} {formatDate(l.expiresAt)} ·{' '}
                    {l.viewCount} views
                  </span>
                </span>
                {l.state === 'active' && (
                  <Button size="sm" variant="ghost" onClick={() => void revoke(l.id)}>
                    <XCircle /> Revoke
                  </Button>
                )}
              </div>
              {l.comments.length > 0 && (
                <ul aria-label="Feedback" className="mt-3 grid gap-2">
                  {l.comments.map((c) => (
                    <li key={c.id} className="rounded-md bg-muted/50 p-2 text-sm">
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <MessageSquare className="size-3" />
                        <bdi className="font-medium text-foreground">{c.authorName}</bdi>
                        {c.authorEmail && <span>· {c.authorEmail}</span>}
                        <span>· {formatDate(c.createdAt)}</span>
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
