'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { BriefHint, briefHintDescribedBy } from '../brief-hint';
import { Field } from '../review/field';
import { pointsFromText, type ItemKind, type PlanItem } from './plan-model';

// 20.9 — one post's topic, brief, format and slide text: the draft editor's inline edit, the
// running plan's "Swap topic" and "Add a post" (moved out of plan-editor.tsx in 25.9).

export interface ItemBody {
  title: string;
  brief: string;
  kind: ItemKind;
  slides: { hook: string; points: string[]; cta: string };
}

/** Topic, brief, format and slide text of one post (the editor and the swap form). */
export function ItemForm({
  item,
  onSave,
  onCancel,
  saveLabel,
}: {
  item: Pick<PlanItem, 'id' | 'title' | 'brief' | 'kind' | 'slides'>;
  onSave: (body: ItemBody) => Promise<void>;
  onCancel: () => void;
  saveLabel?: string;
}) {
  const t = useTranslations('plans.editor');
  const tk = useTranslations('plans.kind');
  const [title, setTitle] = useState(item.title);
  const [brief, setBrief] = useState(item.brief);
  const [kind, setKind] = useState<ItemKind>(item.kind);
  const [hook, setHook] = useState(item.slides?.hook ?? item.title);
  const [points, setPoints] = useState((item.slides?.points ?? []).join('\n'));
  const [cta, setCta] = useState(item.slides?.cta ?? '');
  const [saving, setSaving] = useState(false);
  const id = (field: string) => `item-${item.id}-${field}`;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    const parsed = pointsFromText(points);
    await onSave({
      title: title.trim(),
      brief: brief.trim(),
      kind,
      slides: {
        hook: hook.trim() || title.trim(),
        points: parsed.length ? parsed : [title.trim()],
        cta: cta.trim(),
      },
    });
    setSaving(false);
  }
  return (
    <form onSubmit={submit} className="mt-2 flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <Field id={id('title')} label={t('titleLabel')}>
          <Input
            id={id('title')}
            required
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field id={id('kind')} label={t('kindLabel')}>
          <NativeSelect
            id={id('kind')}
            value={kind}
            onChange={(e) => setKind(e.target.value as ItemKind)}
          >
            <option value="VIDEO">{tk('VIDEO')}</option>
            <option value="SLIDESHOW">{tk('SLIDESHOW')}</option>
            <option value="CAROUSEL">{tk('CAROUSEL')}</option>
          </NativeSelect>
        </Field>
      </div>
      <Field id={id('brief')} label={t('briefLabel')}>
        <Textarea
          id={id('brief')}
          required
          maxLength={600}
          rows={3}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          aria-describedby={briefHintDescribedBy(brief, id('brief-hint'))}
        />
        {/* 20.18: a gentle nudge for a very short brief; Save still works. */}
        <BriefHint text={brief} id={id('brief-hint')} className="mt-2" />
      </Field>
      {kind === 'SLIDESHOW' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={id('hook')} label={t('hookLabel')}>
            <Input
              id={id('hook')}
              maxLength={120}
              value={hook}
              onChange={(e) => setHook(e.target.value)}
            />
          </Field>
          <Field id={id('cta')} label={t('ctaLabel')}>
            <Input
              id={id('cta')}
              maxLength={80}
              value={cta}
              onChange={(e) => setCta(e.target.value)}
            />
          </Field>
          <Field id={id('points')} label={t('pointsLabel')} className="sm:col-span-2">
            <Textarea
              id={id('points')}
              rows={4}
              value={points}
              onChange={(e) => setPoints(e.target.value)}
            />
          </Field>
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={saving}>
          {saveLabel ?? t('save')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={saving}>
          {t('cancelEdit')}
        </Button>
      </div>
    </form>
  );
}
