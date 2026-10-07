'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import type { FormatKey } from '../blitz/blitz-model';
import { ErrorState } from '../primitives';
import { WeightSlider } from './angles-panel';

// 22.4 — the content mix: how often each format is made (paid formats start at 0 and only make
// anything once raised; each uses the plan's videos when kept), remix %, mention-business %,
// and what Blitz learned from swipes (bounded, with a reset). Automations take a snapshot of it.

interface Mix {
  available: FormatKey[];
  formatWeights: Partial<Record<FormatKey, number>>;
  effectiveFormatWeights: Partial<Record<FormatKey, number>>;
  remixPercent: number;
  mentionBusinessPercent: number;
  creatorChance: number;
  adjustments: Array<{ target: 'format' | 'angle' | 'mention'; id: string; delta: number }>;
}

const PAID: ReadonlySet<FormatKey> = new Set(['ai_video', 'ugc']);

export function ContentMixPanel({ businessId }: { businessId: string }) {
  const t = useTranslations('blitz.mix');
  const tf = useTranslations('blitz.deck.format');
  const errorText = useErrorMessage();
  const path = `/businesses/${businessId}/content-mix`;
  const { data, error, mutate } = useApi<{ mix: Mix }>(path);
  const angles = useApi<{ angles: Array<{ id: string; title: string }> }>(
    `/businesses/${businessId}/angles`,
    {
      retired: 1,
    },
  );
  const [draft, setDraft] = useState<Pick<
    Mix,
    'formatWeights' | 'remixPercent' | 'mentionBusinessPercent'
  > | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data && !draft)
      setDraft({
        formatWeights: data.mix.formatWeights,
        remixPercent: data.mix.remixPercent,
        mentionBusinessPercent: data.mix.mentionBusinessPercent,
      });
  }, [data, draft]);

  const put = async (body: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await api<{ mix: Mix }>(path, {
        method: 'PUT',
        body,
        idempotencyKey: newIdempotencyKey(),
      });
      await mutate(res, { revalidate: false });
      setDraft({
        formatWeights: res.mix.formatWeights,
        remixPercent: res.mix.remixPercent,
        mentionBusinessPercent: res.mix.mentionBusinessPercent,
      });
      toast.success(t('saved'));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const angleTitle = (id: string) => angles.data?.angles.find((a) => a.id === id)?.title ?? id;
  const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

  return (
    <section aria-labelledby="mix-title" className="space-y-4">
      <div>
        <h2 id="mix-title" className="font-display text-3xl leading-none">
          {t('title')}
        </h2>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">{t('description')}</p>
      </div>
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {data && draft && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="grid gap-5 rounded-2xl border border-border bg-card p-5">
            <fieldset className="grid gap-4">
              <legend className="mb-1 text-sm font-medium">{t('formats')}</legend>
              {data.mix.available.map((format) => (
                <WeightSlider
                  key={format}
                  id={`mix-${format}`}
                  label={PAID.has(format) ? t('paidFormat', { format: tf(format) }) : tf(format)}
                  value={draft.formatWeights[format] ?? 0}
                  onChange={(v) =>
                    setDraft({ ...draft, formatWeights: { ...draft.formatWeights, [format]: v } })
                  }
                />
              ))}
              <p className="text-xs text-muted-foreground">{t('paidNote')}</p>
            </fieldset>
            <WeightSlider
              id="mix-remix"
              label={t('remix')}
              value={draft.remixPercent}
              onChange={(v) => setDraft({ ...draft, remixPercent: v })}
            />
            <WeightSlider
              id="mix-mention"
              label={t('mention')}
              value={draft.mentionBusinessPercent}
              onChange={(v) => setDraft({ ...draft, mentionBusinessPercent: v })}
            />
            <div>
              <Button onClick={() => void put(draft)} loading={saving}>
                {t('save')}
              </Button>
            </div>
          </div>
          <aside className="space-y-3 rounded-2xl border border-dashed border-border p-5 text-sm">
            <h3 className="font-medium">{t('nudges')}</h3>
            {data.mix.adjustments.length === 0 ? (
              <p className="text-muted-foreground">{t('noNudges')}</p>
            ) : (
              <ul className="space-y-1.5">
                {data.mix.adjustments.map((n) => (
                  <li key={`${n.target}-${n.id}`} className="flex justify-between gap-2">
                    <span className="text-muted-foreground">
                      {n.target === 'format'
                        ? tf(n.id as FormatKey)
                        : n.target === 'angle'
                          ? angleTitle(n.id)
                          : t('mentionShort')}
                    </span>
                    <span className={n.delta < 0 ? 'text-destructive' : 'text-success'}>
                      {signed(n.delta)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {data.mix.adjustments.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => void put({ resetAdjustments: true })}
              >
                <RotateCcw /> {t('reset')}
              </Button>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
