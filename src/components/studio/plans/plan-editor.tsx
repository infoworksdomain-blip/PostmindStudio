'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  Hash,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '../publications/confirm-dialog';
import { Field, NativeSelect } from '../review/field';
import { CappedNotice, ItemMeta } from './plan-parts';
import { ItemCopyEditor } from './item-copy';
import { BusinessHashtagsNote } from '../hashtags/business-hashtags-panel';
import {
  groupByDay,
  kindCounts,
  moveItem,
  pointsFromText,
  type ItemKind,
  type Plan,
  type PlanItem,
} from './plan-model';

type Method = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

// 20.9 — the DRAFT editor: every planned post by day, each editable (topic, brief, format, slide
// text), movable (topics move, times stay), replaceable ("New topic", one Claude call) and
// deletable; posts can be added at a free time. The estimate (posts, cost, allowance) sits above
// "Generate and schedule", which asks once before everything is made and scheduled.

type Change = () => Promise<void>;

export function PlanEditor({ plan, onChange }: { plan: Plan; onChange: Change }) {
  const t = useTranslations('plans.editor');
  const f = useFormat();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [confirming, setConfirming] = useState<'generate' | 'discard' | null>(null);
  const items = plan.items.filter((i) => i.status === 'PLANNED');
  const ids = items.map((i) => i.id);
  const counts = kindCounts(items);
  const base = `/content-plans/${plan.id}`;
  // 20.12: a plan with no connected account makes its posts and saves them for review.
  const noAccounts = plan.targets !== undefined && plan.targets.length === 0;

  async function call(path: string, method: Method, body?: unknown, success?: string) {
    try {
      await api(path, { method, body, idempotencyKey: newIdempotencyKey() });
      if (success) toast.success(success);
      await onChange();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  }

  const move = (id: string, delta: -1 | 1) =>
    call(`${base}/reorder`, 'POST', { itemIds: moveItem(ids, id, delta) });

  return (
    <div className="flex flex-col gap-6">
      <CappedNotice plan={plan} />
      {plan.draftError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <span>{t('draftError')}</span>
          <Button size="sm" variant="outline" onClick={() => void call(`${base}/redraft`, 'POST')}>
            <RefreshCw /> {t('redraft')}
          </Button>
        </div>
      )}
      <section
        aria-labelledby="plan-estimate"
        className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
      >
        <h2 id="plan-estimate" className="text-sm font-semibold">
          {t('summary', {
            count: items.length,
            videos: counts.VIDEO,
            slideshows: counts.SLIDESHOW,
          })}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('costEstimate', {
            typical: f.pence(plan.estimate.typicalPence),
            max: f.pence(plan.estimate.maxPence),
          })}{' '}
          {t('allowanceUse', { count: items.length })}
        </p>
        <p className="text-xs text-muted-foreground">
          {noAccounts ? t('noAccountsWindow') : t('reviewWindow')}
        </p>
        <BusinessHashtagsNote businessId={plan.businessId} />
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => setConfirming('generate')}
            disabled={items.length === 0 || items.some((i) => !i.title)}
          >
            <Send className="rtl:-scale-x-100" /> {t('generate')}
          </Button>
          <Button variant="outline" onClick={() => setConfirming('discard')}>
            {t('discard')}
          </Button>
        </div>
      </section>

      <ol aria-label={t('daysAria')} className="flex flex-col gap-6">
        {groupByDay(items, plan.timezone).map(({ day, items: dayItems }) => (
          <li key={day} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              {f.date(`${day}T12:00:00Z`, { dateStyle: 'full', timeZone: 'UTC' })}
            </h3>
            <ul className="flex flex-col gap-2">
              {dayItems.map((item) => (
                <DraftItemRow
                  key={item.id}
                  plan={plan}
                  item={item}
                  first={ids[0] === item.id}
                  last={ids[ids.length - 1] === item.id}
                  onMove={(delta) => void move(item.id, delta)}
                  call={call}
                />
              ))}
            </ul>
          </li>
        ))}
      </ol>

      <AddPost plan={plan} call={call} />

      <ConfirmDialog
        open={confirming === 'generate'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t('generateConfirmTitle', { count: items.length })}
        description={noAccounts ? t('generateConfirmBodyNoAccounts') : t('generateConfirmBody')}
        confirmLabel={t('generate')}
        cancelLabel={t('notYet')}
        destructive={false}
        onConfirm={() => call(`${base}/generate`, 'POST', undefined, t('generating'))}
      />
      <ConfirmDialog
        open={confirming === 'discard'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t('discardConfirmTitle')}
        description={t('discardConfirmBody')}
        confirmLabel={t('discard')}
        cancelLabel={t('notYet')}
        onConfirm={async () => {
          const done = await call(`${base}/cancel`, 'POST', undefined, t('discarded'));
          if (done) router.push('/plans');
          return done;
        }}
      />
    </div>
  );
}

type Call = (path: string, method: Method, body?: unknown, success?: string) => Promise<boolean>;

function DraftItemRow({
  plan,
  item,
  first,
  last,
  onMove,
  call,
}: {
  plan: Plan;
  item: PlanItem;
  first: boolean;
  last: boolean;
  onMove: (delta: -1 | 1) => void;
  call: Call;
}) {
  const t = useTranslations('plans.editor');
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
  return (
    <li className="rounded-lg border border-border p-3" aria-busy={busy || !item.title}>
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
          <p className="mt-1 font-medium">{title}</p>
          {item.brief && <p className="mt-0.5 text-sm text-muted-foreground">{item.brief}</p>}
          {item.kind === 'SLIDESHOW' && item.slides && (
            <ul className="mt-1 list-disc ps-5 text-xs text-muted-foreground">
              {item.slides.points.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(true)}
              disabled={!item.title}
            >
              <Pencil /> {t('edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={copyOpen}
              aria-label={th('openAria', { title })}
              onClick={() => setCopyOpen((o) => !o)}
              disabled={!item.title}
            >
              <Hash /> {th('open')}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t('moveUp', { title })}
              disabled={first}
              onClick={() => onMove(-1)}
            >
              <ArrowUp />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t('moveDown', { title })}
              disabled={last}
              onClick={() => onMove(1)}
            >
              <ArrowDown />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('regenerateAria', { title })}
              disabled={busy || !item.title}
              onClick={() => void regenerate()}
            >
              {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} {t('regenerate')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('removeAria', { title })}
              onClick={() => void call(path, 'DELETE', undefined, t('removed'))}
            >
              <Trash2 /> {t('remove')}
            </Button>
          </div>
          {copyOpen && (
            <ItemCopyEditor plan={plan} item={item} call={call} onDone={() => setCopyOpen(false)} />
          )}
        </>
      )}
    </li>
  );
}

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
        />
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
        <Button type="submit" size="sm" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />} {saveLabel ?? t('save')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={saving}>
          {t('cancelEdit')}
        </Button>
      </div>
    </form>
  );
}

/** "Add a post" at a free time inside the plan (the API checks the time and 4-a-day limit). */
function AddPost({ plan, call }: { plan: Plan; call: Call }) {
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
      className="rounded-xl border border-dashed border-border p-4"
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
