'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Hash, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { NativeSelect } from '@/components/ui/native-select';
import { Field } from '../review/field';
import { businessHashtagsPath, type BusinessHashtags } from '../hashtags/business-hashtags-panel';
import { withLocked } from '../hashtags/model';
import {
  fallbackCopyInfo,
  PostCopyEditor,
  postCopyProblems,
  type PostCopyInfo,
  type PostCopyValue,
} from '../hashtags/post-copy-editor';
import type { Plan, PlanItem } from './plan-model';

// 20.13 — a planned post's caption and hashtags per platform (month plan editor and the
// scheduled plan view): drafted with the topic, edited here, saved with
// PUT /content-plans/:id/items/:itemId/post-copy (business + always hashtags locked, at least 5,
// the platform's limits). Once the post is generated the edit also reaches its project and its
// scheduled posts.

type Call = (path: string, method: 'PUT', body?: unknown, success?: string) => Promise<boolean>;

export type ItemPostCopy = Partial<Record<string, PostCopyValue>>;

export function ItemCopyEditor({
  plan,
  item,
  call,
  onDone,
}: {
  plan: Pick<Plan, 'id' | 'businessId' | 'platforms'>;
  item: Pick<PlanItem, 'id' | 'title' | 'postCopy'>;
  call: Call;
  onDone: () => void;
}) {
  const t = useTranslations('hashtags.plan');
  const tc = useTranslations('hashtags.copy');
  const f = useFormat();
  const { data } = useApi<{ hashtags: BusinessHashtags }>(businessHashtagsPath(plan.businessId));
  const [platform, setPlatform] = useState(plan.platforms[0] ?? '');
  const [edits, setEdits] = useState<ItemPostCopy>({});
  const [saving, setSaving] = useState(false);
  const locked = data
    ? [
        ...(data.hashtags?.primaryHashtag ? [data.hashtags.primaryHashtag] : []),
        ...(data.hashtags?.alwaysHashtags ?? []),
      ]
    : [];
  const stored = (item.postCopy ?? {})[platform];
  const info: PostCopyInfo = {
    ...fallbackCopyInfo(platform, stored?.caption ?? item.title),
    locked,
  };
  const value: PostCopyValue = edits[platform] ?? {
    caption: stored?.caption ?? item.title,
    hashtags: withLocked(stored?.hashtags ?? [], locked),
    ...(stored?.title && { title: stored.title }),
  };
  const problems = postCopyProblems(value, info);
  const id = `item-copy-${item.id}`;

  async function save() {
    setSaving(true);
    const done = await call(
      `/content-plans/${plan.id}/items/${item.id}/post-copy`,
      'PUT',
      {
        platform,
        caption: value.caption.trim(),
        hashtags: value.hashtags,
        ...(value.title?.trim() && { title: value.title.trim() }),
      },
      tc('saved'),
    );
    setSaving(false);
    if (done) setEdits((e) => ({ ...e, [platform]: undefined }));
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mt-2 flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3"
    >
      <h4 id={`${id}-title`} className="flex items-center gap-1.5 text-sm font-medium">
        <Hash className="size-4" aria-hidden /> {t('title')}
      </h4>
      {plan.platforms.length > 1 && (
        <Field id={`${id}-platform`} label={t('platform')} className="sm:w-60">
          <NativeSelect
            id={`${id}-platform`}
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          >
            {plan.platforms.map((p) => (
              <option key={p} value={p}>
                {f.platform(p)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}
      <PostCopyEditor
        key={platform}
        id={`${id}-${platform}`}
        platformLabel={f.platform(platform)}
        info={info}
        value={value}
        onChange={(next) => setEdits((e) => ({ ...e, [platform]: next }))}
      />
      <p className="text-xs text-muted-foreground">{tc('suggestedNote')}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={saving || problems.short || problems.over || problems.tooLong}
        >
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          {tc('save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t('close')}
        </Button>
      </div>
    </section>
  );
}
