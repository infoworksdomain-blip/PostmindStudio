'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useApi } from '@/lib/client/api';
import { NativeSelect } from '@/components/ui/native-select';
import { Field } from '../review/field';
import { creatorsPath, defaultCreatorId, type Creator } from './types';

// BACKLOG 22.3 — the "Creator" picker on Create → UGC: one of the business's READY creators (the
// same face in every clip, and in every video that picks it) or a new one-off actor (21.4).
// Until the owner picks, the business's most used creator is chosen; with none, a one-off actor.

export const ONE_OFF = 'one-off';

export function CreatorPicker({
  businessId,
  value,
  onChange,
}: {
  businessId: string;
  /** A creator id, null for a one-off actor, undefined until the default is applied. */
  value: string | null | undefined;
  onChange: (creatorId: string | null) => void;
}) {
  const t = useTranslations('create.ugc');
  const { data, error } = useApi<{ data: Creator[] }>(creatorsPath(businessId));
  const ready = (data?.data ?? []).filter((c) => c.status === 'READY' && c.portraitUrl);
  const loaded = Boolean(data) || Boolean(error);
  const fallback = defaultCreatorId(ready);
  // The latest onChange, so applying the default does not depend on the parent's callback.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  // A creator of another business (the business was switched) or a retired one is replaced too.
  const readyIds = ready.map((c) => c.id).join(',');
  useEffect(() => {
    if (!loaded) return;
    const stale = typeof value === 'string' && !readyIds.split(',').includes(value);
    if (value === undefined || stale) onChangeRef.current(fallback);
  }, [value, loaded, fallback, readyIds]);

  const selected = ready.find((c) => c.id === value) ?? null;
  return (
    <div className="flex flex-col gap-2" data-testid="creator-picker">
      <div className="flex items-end gap-3">
        {selected?.portraitUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- signed storage URL, not optimisable
          <img
            src={selected.portraitUrl}
            alt={t('creatorPortraitAlt', { name: selected.name })}
            className="size-14 shrink-0 rounded-xl border border-border object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <Field id="create-ugc-creator" label={t('creator')}>
            <NativeSelect
              id="create-ugc-creator"
              value={value ?? ONE_OFF}
              onChange={(e) => onChange(e.target.value === ONE_OFF ? null : e.target.value)}
            >
              {ready.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value={ONE_OFF}>{t('creatorOneOff')}</option>
            </NativeSelect>
          </Field>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('creatorHint')}{' '}
        <Link href="/business?tab=creators" className="underline underline-offset-2">
          {t('creatorManage')}
        </Link>
      </p>
    </div>
  );
}
