'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Hash, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Field } from '../review/field';
import { ItemCopyEditor } from './item-copy';
import { ItemForm } from './item-form';
import { ItemMeta } from './plan-parts';
import type { Plan, PlanItem } from './plan-model';

// 20.9 — one post of a DRAFT plan: its time, format and angle, topic and brief (slide points for
// a slideshow), and its actions — edit inline, caption and hashtags (20.13), move earlier / later
// (topics move, times stay; POST …/reorder), a new topic (one Claude call), delete. 25.9: a
// checkbox selects it for the bulk actions above the timeline.

type Method = 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type Call = (
  path: string,
  method: Method,
  body?: unknown,
  success?: string,
) => Promise<boolean>;

export function DraftItemRow({
  plan,
  item,
  first,
  last,
  selected,
  onSelect,
  onMove,
  call,
  locked,
}: {
  plan: Plan;
  item: PlanItem;
  first: boolean;
  last: boolean;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  onMove: (delta: -1 | 1) => void;
  call: Call;
  /** A bulk run is going: the item's own actions wait. */
  locked: boolean;
}) {
  const t = useTranslations('plans.editor');
  const tb = useTranslations('plans.bulk');
  const th = useTranslations('hashtags.plan');
  const [editing, setEditing] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const path = `/content-plans/${plan.id}/items/${item.id}`;
  const title = item.title || t('untitled');
  const regenerate = async () => {
    setBusy(true);
    await call(`${path}/regenerate`, 'POST');
    setBusy(false);
  };
  const off = locked || !item.title;
  return (
    <li
      className={cn(
        'group/item rounded-panel border bg-card p-4 transition-colors duration-(--duration-fast)',
        selected ? 'border-foreground/40 bg-surface-raised/60' : 'border-border',
      )}
      aria-busy={busy || !item.title}
      data-plan-item={item.id}
    >
      <div className="flex items-start gap-3">
        <Checkbox
          className="mt-0.5"
          checked={selected}
          disabled={off}
          onCheckedChange={(v) => onSelect(v === true)}
          aria-label={tb('selectItem', { title })}
        />
        <div className="min-w-0 flex-1">
          <ItemMeta item={item} timezone={plan.timezone} />
          {editing ? (
            <ItemForm
              item={item}
              onCancel={() => setEditing(false)}
              onSave={async (body) => {
                const done = await call(path, 'PATCH', body, t('saved'));
                if (done) setEditing(false);
              }}
            />
          ) : (
            <>
              <p className="mt-1.5 font-medium">{title}</p>
              {item.brief && <p className="mt-0.5 text-sm text-muted-foreground">{item.brief}</p>}
              {item.kind === 'SLIDESHOW' && item.slides && (
                <ul className="mt-1 list-disc ps-5 text-xs text-muted-foreground">
                  {item.slides.points.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={off}>
                  <Pencil /> {t('edit')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={copyOpen}
                  aria-label={th('openAria', { title })}
                  onClick={() => setCopyOpen((o) => !o)}
                  disabled={off}
                >
                  <Hash /> {th('open')}
                </Button>
                <IconButton
                  size="icon"
                  label={t('moveUp', { title })}
                  disabled={first || locked}
                  onClick={() => onMove(-1)}
                >
                  <ArrowUp />
                </IconButton>
                <IconButton
                  size="icon"
                  label={t('moveDown', { title })}
                  disabled={last || locked}
                  onClick={() => onMove(1)}
                >
                  <ArrowDown />
                </IconButton>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('regenerateAria', { title })}
                  loading={busy}
                  disabled={off}
                  onClick={() => void regenerate()}
                >
                  {!busy && <RefreshCw />} {t('regenerate')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('removeAria', { title })}
                  disabled={locked}
                  onClick={() => void call(path, 'DELETE', undefined, t('removed'))}
                >
                  <Trash2 /> {t('remove')}
                </Button>
              </div>
              {copyOpen && (
                <ItemCopyEditor
                  plan={plan}
                  item={item}
                  call={call}
                  onDone={() => setCopyOpen(false)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
}

/** "Add a post" at a free time inside the plan (the API checks the time and 4-a-day limit). */
export function AddPost({ plan, call }: { plan: Plan; call: Call }) {
  const t = useTranslations('plans.editor');
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState('');
  if (!open)
    return (
      <div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          <Plus /> {t('addTitle')}
        </Button>
      </div>
    );
  return (
    <section
      aria-labelledby="plan-add"
      className="rounded-panel border border-dashed border-border p-4"
    >
      <h2 id="plan-add" className="mb-3 text-sm font-semibold">
        {t('addTitle')}
      </h2>
      <Field id="plan-add-when" label={t('addWhen')} hint={t('addWhenHint')}>
        <Input
          id="plan-add-when"
          type="datetime-local"
          required
          value={when}
          min={plan.windowStart.slice(0, 16)}
          max={plan.windowEnd.slice(0, 16)}
          onChange={(e) => setWhen(e.target.value)}
        />
      </Field>
      <ItemForm
        item={{ id: 'new', title: '', brief: '', kind: 'VIDEO', slides: null }}
        saveLabel={t('addSubmit')}
        onCancel={() => setOpen(false)}
        onSave={async (body) => {
          if (!when) return;
          const done = await call(
            `/content-plans/${plan.id}/items`,
            'POST',
            { ...body, slotAt: new Date(when).toISOString() },
            t('added'),
          );
          if (done) {
            setOpen(false);
            setWhen('');
          }
        }}
      />
    </section>
  );
}
