'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Hash, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { ErrorState } from '../primitives';
import { HashtagEditor } from './hashtag-editor';
import { cleanOwnerHashtag } from './model';

// 20.13 — Business settings → Hashtags: the business hashtag every post carries (default from
// the business name, editable) and the "always include" hashtags (campaign / brand tags).
// GET/PUT /api/studio/businesses/:id/hashtags. BusinessHashtagsNote shows them read-only on
// Create, the month planner and Publish, with a link here.

export interface BusinessHashtags {
  primaryHashtag: string | null;
  derivedHashtag: string | null;
  custom: boolean;
  alwaysHashtags: string[];
  minHashtags: number;
  maxChars: number;
  maxAlways: number;
  updatedAt: string | null;
}

export const businessHashtagsPath = (businessId: string) =>
  `/businesses/${encodeURIComponent(businessId)}/hashtags`;

function HashtagsForm({
  businessId,
  saved,
  onSaved,
}: {
  businessId: string;
  saved: BusinessHashtags;
  onSaved: (next: BusinessHashtags) => void;
}) {
  const t = useTranslations('hashtags.settings');
  const errorMessage = useErrorMessage();
  const [primary, setPrimary] = useState(saved.custom ? (saved.primaryHashtag ?? '') : '');
  const [always, setAlways] = useState(saved.alwaysHashtags);
  const [saving, setSaving] = useState(false);
  const typed = primary.trim();
  const valid = !typed || cleanOwnerHashtag(typed, saved.maxChars) !== null;
  const needsOne = !typed && !saved.derivedHashtag;

  async function save() {
    setSaving(true);
    try {
      const res = await api<{ hashtags: BusinessHashtags }>(businessHashtagsPath(businessId), {
        method: 'PUT',
        idempotencyKey: newIdempotencyKey(),
        body: { primaryHashtag: typed ? typed.replace(/^#+/, '') : null, alwaysHashtags: always },
      });
      onSaved(res.hashtags);
      toast.success(t('saved'));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="business-hashtag" className="text-sm font-medium">
          {t('business')}
        </label>
        <div className="flex items-center gap-2">
          <Hash className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            id="business-hashtag"
            dir="auto"
            value={primary}
            placeholder={saved.derivedHashtag ?? ''}
            maxLength={saved.maxChars + 1}
            aria-invalid={!valid || needsOne ? true : undefined}
            aria-describedby="business-hashtag-hint"
            onChange={(e) => setPrimary(e.target.value)}
          />
          {typed && saved.derivedHashtag && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setPrimary('')}>
              {t('useDefault')}
            </Button>
          )}
        </div>
        <p id="business-hashtag-hint" className="text-xs text-muted-foreground">
          {t('businessHint', { max: saved.maxChars })}{' '}
          {saved.derivedHashtag ? t('default', { tag: saved.derivedHashtag }) : t('noDefault')}
        </p>
        {!valid && (
          <p role="alert" className="text-xs text-destructive">
            {t('invalid', { max: saved.maxChars })}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <HashtagEditor
          id="always-hashtags"
          label={t('always')}
          value={always}
          onChange={setAlways}
          max={saved.maxAlways}
          maxChars={saved.maxChars}
          ownerRules
        />
        <p className="text-xs text-muted-foreground">{t('alwaysHint', { max: saved.maxAlways })}</p>
      </div>
      <div>
        <Button loading={saving} onClick={save} disabled={saving || !valid || needsOne}>
          {!saving && <Save />}
          {t('save')}
        </Button>
      </div>
    </div>
  );
}

export function BusinessHashtagsPanel({ businessId }: { businessId: string }) {
  const t = useTranslations('hashtags.settings');
  const { data, error, isLoading, mutate } = useApi<{ hashtags: BusinessHashtags }>(
    businessHashtagsPath(businessId),
  );
  return (
    <section className="flex flex-col gap-4" aria-labelledby="hashtags-title">
      <div>
        <h2 id="hashtags-title" className="text-base font-semibold">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('description', { min: data?.hashtags?.minHashtags ?? 5 })}
        </p>
      </div>
      {isLoading && <Skeleton className="h-40 max-w-2xl" />}
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {data?.hashtags && (
        <HashtagsForm
          key={data.hashtags.updatedAt ?? 'new'}
          businessId={businessId}
          saved={data.hashtags}
          onSaved={(hashtags) => void mutate({ hashtags }, { revalidate: false })}
        />
      )}
    </section>
  );
}

/** Read-only: the hashtags every post of the business carries, with a link to edit them. */
export function BusinessHashtagsNote({ businessId }: { businessId: string | null }) {
  const t = useTranslations('hashtags.note');
  const { data } = useApi<{ hashtags: BusinessHashtags }>(
    businessId ? businessHashtagsPath(businessId) : null,
  );
  const settings = data?.hashtags;
  if (!settings) return null;
  const tags = [
    ...(settings.primaryHashtag ? [settings.primaryHashtag] : []),
    ...(settings.alwaysHashtags ?? []),
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <Hash className="size-3.5 shrink-0" aria-hidden />
      <span className="font-medium text-foreground">{t('title')}</span>
      {tags.length ? (
        <span dir="auto">
          {t('body', {
            tags: tags.map((tag) => `#${tag}`).join(' '),
            min: settings.minHashtags,
          })}
        </span>
      ) : (
        <span>{t('none')}</span>
      )}
      <Link href="/business?tab=hashtags" className="underline underline-offset-2">
        {t('edit')}
      </Link>
    </div>
  );
}
