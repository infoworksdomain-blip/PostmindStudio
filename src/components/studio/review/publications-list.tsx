'use client';

import { ExternalLink, Loader2, RotateCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  formatDate,
  PLATFORM_LABEL,
  PUBLICATION_STATE,
  safeHttpUrl,
  stateOf,
} from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { StateBadge } from '../primitives';
import { useAction } from './use-action';

// This project's publications: cancel a scheduled one, retry a failed one (spec 8.4).

export function PublicationsList({
  publications,
  onChanged,
}: {
  publications: Publication[];
  onChanged: () => void;
}) {
  const { pending, run, busy } = useAction();
  if (publications.length === 0)
    return <p className="text-sm text-muted-foreground">Nothing published or scheduled yet.</p>;

  async function act(publication: Publication, action: 'cancel' | 'retry') {
    const ok = await run(
      `${action}-${publication.id}`,
      `/publications/${publication.id}/${action}`,
      {
        success: action === 'cancel' ? 'Scheduled post cancelled.' : 'Retrying.',
      },
    );
    if (ok) onChanged();
  }

  return (
    <ul className="divide-y divide-border">
      {publications.map((p) => {
        const label = PLATFORM_LABEL[p.platform] ?? p.platform;
        const platformUrl = safeHttpUrl(p.platformUrl);
        return (
          <li key={p.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{label}</p>
              <p className="truncate text-xs text-muted-foreground">
                {p.state === 'SCHEDULED'
                  ? `For ${formatDate(p.scheduledFor)}`
                  : p.publishedAt
                    ? `Live since ${formatDate(p.publishedAt)}`
                    : `Created ${formatDate(p.createdAt)}`}
                {p.errorReason && ` — ${p.errorReason}`}
              </p>
            </div>
            <StateBadge {...stateOf(PUBLICATION_STATE, p.state)} />
            {platformUrl && (
              <Button asChild variant="ghost" size="sm">
                <a href={platformUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink /> View
                </a>
              </Button>
            )}
            {p.state === 'SCHEDULED' && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => act(p, 'cancel')}
                aria-label={`Cancel ${label} post`}
              >
                {pending === `cancel-${p.id}` ? <Loader2 className="animate-spin" /> : <X />}
                Cancel
              </Button>
            )}
            {p.state === 'FAILED' && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => act(p, 'retry')}
                aria-label={`Retry ${label} post`}
              >
                {pending === `retry-${p.id}` ? <Loader2 className="animate-spin" /> : <RotateCw />}
                Retry
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
