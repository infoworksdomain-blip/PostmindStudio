'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Brain, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import { formatDate } from '@/lib/client/format';
import { EmptyState, ErrorState } from '../primitives';

// BACKLOG 13.29 / spec 10.4 — "What Studio has learned": every inferred preference with the
// reason it was inferred, and a delete per item (users must be able to remove inferred data).
// Data: GET|DELETE /api/studio/businesses/:id/style-memory (services/style-memory.ts).

export interface StyleMemoryItem {
  id: string;
  signalType: string;
  value: string;
  reason: string;
  weight: number;
  evidenceCount: number;
  lastEvidenceAt: string | null;
  updatedAt: string;
}

interface StyleMemoryResponse {
  ok: true;
  data: StyleMemoryItem[];
}

export const SIGNAL_LABEL: Record<string, string> = {
  shot_pace: 'Shot pace',
  treatment_mix: 'Visual mix',
  provider_preference: 'Generators that work',
  script_structure: 'Script structure',
  posting_time: 'Best time to post',
};

/** Weight (0–1) as a plain-language confidence. */
export function confidence(weight: number): string {
  if (weight >= 0.6) return 'Strong signal';
  if (weight >= 0.3) return 'Emerging signal';
  return 'Weak signal (not used in scripts yet)';
}

export function StyleMemoryPanel({ businessId }: { businessId: string }) {
  const path = `/businesses/${encodeURIComponent(businessId)}/style-memory`;
  const { data, error, isLoading, mutate } = useApi<StyleMemoryResponse>(path);
  const [deleting, setDeleting] = useState<string | null>(null);

  const remove = async (item: StyleMemoryItem) => {
    setDeleting(item.id);
    try {
      await api(`${path}/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(`${SIGNAL_LABEL[item.signalType] ?? item.signalType} forgotten`);
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="grid gap-5">
      <p className="max-w-2xl text-sm text-muted-foreground">
        Studio learns from what you approve, reject and regenerate, and from how your published
        videos perform (last 90 days). Strong signals guide new scripts. Delete anything you
        disagree with: it is removed straight away and only relearned from newer videos.
      </p>
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && <Skeleton aria-label="Loading style memory" className="h-48 rounded-xl" />}
      {data && data.data.length === 0 && (
        <EmptyState
          icon={<Brain className="size-8" strokeWidth={1.5} />}
          title="Nothing learned yet"
          description="After a few approved or published videos, Studio shows what it has picked up here."
        />
      )}
      {data && data.data.length > 0 && (
        <ul aria-label="What Studio has learned" className="grid gap-3">
          {data.data.map((item) => {
            const label = SIGNAL_LABEL[item.signalType] ?? item.signalType;
            return (
              <li
                key={item.id}
                className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-[1fr_auto] sm:items-start"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
                    {label}
                  </p>
                  <p className="mt-1 font-medium">{item.value}</p>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">Why: </span>
                    {item.reason}
                  </p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {confidence(item.weight)} · {item.evidenceCount} pieces of evidence
                    {item.lastEvidenceAt ? ` · latest ${formatDate(item.lastEvidenceAt)}` : ''}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Delete ${label}`}
                  disabled={deleting === item.id}
                  onClick={() => void remove(item)}
                >
                  {deleting === item.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  Delete
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
