'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Brain, Check, Loader2, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState } from '../primitives';

// BACKLOG 13.29 / spec 10.4 — "What Studio has learned": every inferred preference with the
// reason it was inferred, and a delete per item (users must be able to remove inferred data).
// 15.E6 ("view and edit"): correct the value (which pins it so the nightly build keeps it), pin /
// unpin, and switch a memory off so it no longer guides scripts.
// Data: GET /api/studio/businesses/:id/style-memory, PATCH|DELETE …/:memoryId.

export interface StyleMemoryItem {
  id: string;
  signalType: string;
  value: string;
  reason: string;
  weight: number;
  evidenceCount: number;
  lastEvidenceAt: string | null;
  updatedAt: string;
  pinned?: boolean;
  disabled?: boolean;
}

interface StyleMemoryResponse {
  ok: true;
  data: StyleMemoryItem[];
}

/** Signal types with a label (business.memory.signals.*); others show their raw type. */
export const SIGNAL_TYPES = [
  'shot_pace',
  'treatment_mix',
  'provider_preference',
  'script_structure',
  'posting_time',
] as const;

type SignalType = (typeof SIGNAL_TYPES)[number];

function isSignalType(value: string): value is SignalType {
  return (SIGNAL_TYPES as readonly string[]).includes(value);
}

export type Confidence = 'strong' | 'emerging' | 'weak';

/** Weight (0–1) as a plain-language confidence (business.memory.confidence.*). */
export function confidence(weight: number): Confidence {
  if (weight >= 0.6) return 'strong';
  if (weight >= 0.3) return 'emerging';
  return 'weak';
}

export function StyleMemoryPanel({ businessId }: { businessId: string }) {
  const t = useTranslations('business.memory');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const labelOf = (signalType: string) =>
    isSignalType(signalType) ? t(`signals.${signalType}`) : signalType;
  const path = `/businesses/${encodeURIComponent(businessId)}/style-memory`;
  const { data, error, isLoading, mutate } = useApi<StyleMemoryResponse>(path);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  const patch = async (item: StyleMemoryItem, body: Record<string, unknown>, done: string) => {
    try {
      await api(`${path}/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body,
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(done);
      setEditing(null);
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async (item: StyleMemoryItem) => {
    setDeleting(item.id);
    try {
      await api(`${path}/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('forgotten', { label: labelOf(item.signalType) }));
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="grid gap-5">
      <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && <Skeleton aria-label={t('loading')} className="h-48 rounded-xl" />}
      {data && data.data.length === 0 && (
        <EmptyState
          icon={<Brain className="size-8" strokeWidth={1.5} />}
          title={t('empty.title')}
          description={t('empty.body')}
        />
      )}
      {data && data.data.length > 0 && (
        <ul aria-label={t('listAria')} className="grid gap-3">
          {data.data.map((item) => {
            const label = labelOf(item.signalType);
            const evidence = {
              confidence: t(`confidence.${confidence(item.weight)}`),
              count: item.evidenceCount,
            };
            return (
              <li
                key={item.id}
                className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-[1fr_auto] sm:items-start"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
                    {label}
                  </p>
                  {editing?.id === item.id ? (
                    <form
                      className="mt-1 flex items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void patch(item, { value: editing.value }, t('updatedPinned', { label }));
                      }}
                    >
                      <Input
                        dir="auto"
                        aria-label={t('newValueAria', { label })}
                        maxLength={200}
                        value={editing.value}
                        onChange={(e) => setEditing({ id: item.id, value: e.target.value })}
                      />
                      <Button size="sm" type="submit" disabled={!editing.value.trim()}>
                        <Check /> {t('save')}
                      </Button>
                    </form>
                  ) : (
                    <p dir="auto" className="mt-1 font-medium">
                      {item.value}
                      {item.pinned && (
                        <span className="ms-2 text-xs font-normal text-muted-foreground">
                          {t('pinned')}
                        </span>
                      )}
                      {item.disabled && (
                        <span className="ms-2 text-xs font-normal text-muted-foreground">
                          {t('notUsed')}
                        </span>
                      )}
                    </p>
                  )}
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    {t.rich('why', {
                      reason: item.reason,
                      label: (chunks) => (
                        <span className="font-medium text-foreground">{chunks}</span>
                      ),
                    })}
                  </p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {item.lastEvidenceAt
                      ? t('evidenceLatest', { ...evidence, date: f.date(item.lastEvidenceAt) })
                      : t('evidence', evidence)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Switch
                      aria-label={t('useAria', { label })}
                      checked={!item.disabled}
                      onCheckedChange={(on) =>
                        void patch(
                          item,
                          { disabled: !on },
                          on ? t('turnedOn', { label }) : t('turnedOff', { label }),
                        )
                      }
                    />
                    {t('use')}
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('editAria', { label })}
                    onClick={() => setEditing({ id: item.id, value: item.value })}
                  >
                    <Pencil /> {t('edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={item.pinned ? t('unpinAria', { label }) : t('pinAria', { label })}
                    onClick={() =>
                      void patch(
                        item,
                        { pinned: !item.pinned },
                        item.pinned ? t('unpinnedToast', { label }) : t('pinnedToast', { label }),
                      )
                    }
                  >
                    {item.pinned ? <PinOff /> : <Pin />} {item.pinned ? t('unpin') : t('pin')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t('deleteAria', { label })}
                    disabled={deleting === item.id}
                    onClick={() => void remove(item)}
                  >
                    {deleting === item.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                    {t('delete')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
