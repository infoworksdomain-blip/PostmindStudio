'use client';

import { useTranslations } from 'next-intl';
import { ShieldCheck, UserRound } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useApi } from '@/lib/client/api';
import { UGC_VIDEO_ALLOWANCE_UNITS } from '@/lib/studio/ugc/allowance';
import { Field, NativeSelect } from '../review/field';
import type { BusinessProfile } from '../business/types';
import { ImagePicker } from '../slideshow/image-picker';
import type { UgcChoice } from './body';

// BACKLOG 21.4 — the "UGC actor" choices on Create: an optional product (a name, suggested from
// the business profile, and a photo from the business's image library) and an optional actor look
// from small preset lists. Whatever is left open Studio picks, the same way for every clip. The
// note says how much of the allowance the video uses; a cost is never shown.

export const UGC_AGE_RANGES = ['18-24', '25-34', '35-44', '45-60'] as const;
export const UGC_GENDERS = ['woman', 'man'] as const;
export const UGC_SETTINGS = [
  'kitchen',
  'living_room',
  'car',
  'outdoors',
  'bathroom',
  'desk',
  'shop',
] as const;

export function UgcOptions({
  businessId,
  value,
  onChange,
}: {
  businessId: string | null;
  value: UgcChoice;
  onChange: (next: UgcChoice) => void;
}) {
  const t = useTranslations('create.ugc');
  // Product names from the business profile (website scan or the owner's edits), as suggestions.
  const profile = useApi<{ profile: BusinessProfile | null }>(
    businessId ? `/businesses/${encodeURIComponent(businessId)}/business-profile` : null,
  );
  const products = profile.data?.profile?.products ?? [];
  const set = (next: Partial<UgcChoice>) => onChange({ ...value, ...next });

  return (
    <section
      aria-labelledby="create-ugc-title"
      className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <UserRound className="mt-0.5 size-5 shrink-0" strokeWidth={1.5} aria-hidden />
          <div>
            <h2 id="create-ugc-title" className="text-sm font-medium">
              {t('title')}
            </h2>
            <p className="text-xs text-muted-foreground">{t('intro')}</p>
          </div>
        </div>
        <p
          className="rounded-full border border-border px-2.5 py-0.5 text-xs"
          data-testid="ugc-allowance"
        >
          {t('allowance', { count: UGC_VIDEO_ALLOWANCE_UNITS })}
        </p>
      </div>

      <Field id="create-ugc-product" label={t('product')}>
        <Input
          id="create-ugc-product"
          value={value.productName}
          maxLength={120}
          list={products.length ? 'create-ugc-products' : undefined}
          placeholder={t('productPlaceholder')}
          onChange={(e) => set({ productName: e.target.value })}
        />
      </Field>
      {products.length > 0 && (
        <datalist id="create-ugc-products">
          {products.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      )}

      {businessId && (
        <div className="flex flex-col gap-1.5">
          <p id="create-ugc-photo" className="text-xs font-medium text-muted-foreground">
            {t('productImage')}
          </p>
          <ImagePicker
            businessId={businessId}
            value={value.productImageId}
            onChange={(productImageId) => set({ productImageId })}
            label={t('productImage')}
          />
          <p className="text-xs text-muted-foreground">{t('productImageHint')}</p>
        </div>
      )}

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">{t('look')}</legend>
        <Field id="create-ugc-age" label={t('age')}>
          <NativeSelect
            id="create-ugc-age"
            value={value.ageRange}
            onChange={(e) => set({ ageRange: e.target.value as UgcChoice['ageRange'] })}
          >
            <option value="">{t('any')}</option>
            {UGC_AGE_RANGES.map((a) => (
              <option key={a} value={a}>
                {t(`ages.${a}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="create-ugc-gender" label={t('gender')}>
          <NativeSelect
            id="create-ugc-gender"
            value={value.gender}
            onChange={(e) => set({ gender: e.target.value as UgcChoice['gender'] })}
          >
            <option value="">{t('any')}</option>
            {UGC_GENDERS.map((g) => (
              <option key={g} value={g}>
                {t(`genders.${g}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="create-ugc-setting" label={t('setting')}>
          <NativeSelect
            id="create-ugc-setting"
            value={value.setting}
            onChange={(e) => set({ setting: e.target.value as UgcChoice['setting'] })}
          >
            <option value="">{t('any')}</option>
            {UGC_SETTINGS.map((s) => (
              <option key={s} value={s}>
                {t(`settings.${s}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </fieldset>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} aria-hidden />
        {t('disclosure')}
      </p>
    </section>
  );
}
