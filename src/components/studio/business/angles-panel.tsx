'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Archive, ArchiveRestore, Loader2, PencilLine, Plus, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState } from '../primitives';
import { Field } from '../review/field';
import { ContentMixPanel } from './content-mix-panel';

// 22.4 — Business → Angles: the themes Blitz and automations write for (title, description,
// target audience, how often), retire / restore, and "Suggest angles" (Claude, from the business
// profile, never repeating a title). The content mix sits under it.

export interface Angle {
  id: string;
  title: string;
  description: string;
  targetAudience: string;
  weight: number;
  source: 'owner' | 'ai';
  retired: boolean;
}

interface Draft {
  title: string;
  description: string;
  targetAudience: string;
  weight: number;
}

const EMPTY: Draft = { title: '', description: '', targetAudience: '', weight: 50 };

export function AnglesPanel({ businessId }: { businessId: string }) {
  return (
    <div className="grid gap-12">
      <AnglesList businessId={businessId} />
      <ContentMixPanel businessId={businessId} />
    </div>
  );
}

function AnglesList({ businessId }: { businessId: string }) {
  const t = useTranslations('blitz.angles');
  const errorText = useErrorMessage();
  const path = `/businesses/${businessId}/angles`;
  const { data, error, mutate } = useApi<{ angles: Angle[]; max: number }>(path, { retired: 1 });
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  const live = data?.angles.filter((a) => !a.retired) ?? [];
  const retired = data?.angles.filter((a) => a.retired) ?? [];

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing === 'new')
        await api(path, { method: 'POST', body: draft, idempotencyKey: newIdempotencyKey() });
      else if (editing)
        await api(`${path}/${editing}`, {
          method: 'PATCH',
          body: draft,
          idempotencyKey: newIdempotencyKey(),
        });
      setEditing(null);
      setDraft(EMPTY);
      await mutate();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSaving(false);
    }
  };
  const patch = async (id: string, body: Partial<Draft> & { retired?: boolean }) => {
    try {
      await api(`${path}/${id}`, { method: 'PATCH', body, idempotencyKey: newIdempotencyKey() });
      await mutate();
    } catch (err) {
      toast.error(errorText(err));
    }
  };
  const suggest = async () => {
    setSuggesting(true);
    try {
      const res = await api<{ angles: Angle[] }>(`${path}/suggest`, {
        method: 'POST',
        body: { count: 5 },
        idempotencyKey: newIdempotencyKey(),
      });
      toast(res.angles.length ? t('suggested', { count: res.angles.length }) : t('noneNew'));
      await mutate();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSuggesting(false);
    }
  };

  const form = (
    <form
      onSubmit={save}
      className="grid gap-4 rounded-2xl border border-primary/30 bg-card p-5 shadow-sm"
    >
      <Field id="angle-title" label={t('titleLabel')}>
        <Input
          id="angle-title"
          required
          maxLength={80}
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </Field>
      <Field id="angle-description" label={t('descriptionLabel')}>
        <Textarea
          id="angle-description"
          maxLength={400}
          rows={2}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </Field>
      <Field id="angle-audience" label={t('audienceLabel')}>
        <Input
          id="angle-audience"
          maxLength={200}
          value={draft.targetAudience}
          onChange={(e) => setDraft({ ...draft, targetAudience: e.target.value })}
        />
      </Field>
      <WeightSlider
        id="angle-weight"
        label={t('weightLabel')}
        value={draft.weight}
        onChange={(weight) => setDraft({ ...draft, weight })}
      />
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />} {t('save')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );

  return (
    <section aria-labelledby="angles-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="angles-title" className="font-display text-3xl leading-none">
            {t('title')}
          </h2>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data && (
            <span className="text-xs text-muted-foreground">
              {t('count', { count: live.length, max: data.max })}
            </span>
          )}
          <Button variant="outline" disabled={suggesting} onClick={() => void suggest()}>
            {suggesting ? <Loader2 className="animate-spin" /> : <Sparkles />}{' '}
            {suggesting ? t('suggesting') : t('suggest')}
          </Button>
          <Button
            onClick={() => {
              setDraft(EMPTY);
              setEditing('new');
            }}
          >
            <Plus /> {t('add')}
          </Button>
        </div>
      </div>
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {editing === 'new' && form}
      {data && live.length === 0 && editing !== 'new' && (
        <EmptyState title={t('empty')} description={t('emptyBody')} />
      )}
      <ul className="grid gap-3 md:grid-cols-2">
        {live.map((angle) =>
          editing === angle.id ? (
            <li key={angle.id} className="md:col-span-2">
              {form}
            </li>
          ) : (
            <li
              key={angle.id}
              className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{angle.title}</p>
                  {angle.description && (
                    <p className="text-sm text-muted-foreground">{angle.description}</p>
                  )}
                  {angle.targetAudience && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('forAudience', { audience: angle.targetAudience })}
                    </p>
                  )}
                </div>
                {angle.source === 'ai' && (
                  <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                    {t('ai')}
                  </span>
                )}
              </div>
              <WeightSlider
                id={`weight-${angle.id}`}
                label={t('weightLabel')}
                value={angle.weight}
                onCommit={(weight) => void patch(angle.id, { weight })}
              />
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraft({
                      title: angle.title,
                      description: angle.description,
                      targetAudience: angle.targetAudience,
                      weight: angle.weight,
                    });
                    setEditing(angle.id);
                  }}
                >
                  <PencilLine /> {t('edit')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void patch(angle.id, { retired: true })}
                >
                  <Archive /> {t('retire')}
                </Button>
              </div>
            </li>
          ),
        )}
      </ul>
      {retired.length > 0 && (
        <details className="rounded-xl border border-dashed border-border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            {t('retiredTitle', { count: retired.length })}
          </summary>
          <ul className="mt-3 space-y-2">
            {retired.map((angle) => (
              <li key={angle.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">{angle.title}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void patch(angle.id, { retired: false })}
                >
                  <ArchiveRestore /> {t('restore')}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function WeightSlider({
  id,
  label,
  value,
  onChange,
  onCommit,
  disabled = false,
  className,
}: {
  id: string;
  label: string;
  value: number;
  onChange?: (value: number) => void;
  onCommit?: (value: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations('blitz.mix');
  const [local, setLocal] = useState(value);
  const shown = onChange ? value : local;
  return (
    <div className={cn('grid gap-1.5', className)}>
      <div className="flex items-center justify-between text-xs">
        <label htmlFor={id} className="font-medium text-muted-foreground">
          {label}
        </label>
        <span className="tabular-nums">{t('percent', { value: shown })}</span>
      </div>
      <Slider
        id={id}
        min={0}
        max={100}
        step={5}
        value={[shown]}
        disabled={disabled}
        aria-label={label}
        onValueChange={([v]) => {
          if (v === undefined) return;
          if (onChange) onChange(v);
          else setLocal(v);
        }}
        onValueCommit={([v]) => v !== undefined && onCommit?.(v)}
      />
    </div>
  );
}
