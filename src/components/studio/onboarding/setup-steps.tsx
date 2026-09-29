'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { Building2, Globe2, Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, useApi, useErrorMessage } from '@/lib/client/api';
import { isLocale, LOCALE_INFO, LOCALES } from '@/lib/i18n/locales';
import { useBusiness } from '../business-context';
import { selectClass } from '../library/library-filters';
import { EmptyState } from '../primitives';
import { countryOptions } from '../settings/countries';

// Phase 18 §3 onboarding, before the wizard's own steps: (1) create the organisation — the
// signed-in user has none yet (403 no_organisation), or chose "New organisation" in the
// switcher; (2) the first business. Organisation creation is Track A's
// POST /api/studio/organisations { name, country, defaultLocale } (it becomes the session's
// active organisation); businesses are Track D's GET|POST /api/studio/businesses. In core mode
// the business list belongs to Core (GET answers 501), so the old "set up a business" link stays.

export const ORGANISATIONS_PATH = '/organisations';
export const BUSINESSES_PATH = '/businesses';

export interface BusinessSummary {
  id: string;
  name: string;
  domain?: string;
}

export interface BusinessesResponse {
  ok: true;
  data: BusinessSummary[];
}

export function CreateOrganisationStep() {
  const t = useTranslations('onboarding.organisation');
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const countries = useMemo(() => countryOptions(locale), [locale]);
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [defaultLocale, setDefaultLocale] = useState(isLocale(locale) ? locale : 'en-GB');
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api(ORGANISATIONS_PATH, {
        method: 'POST',
        body: { name: name.trim(), country, defaultLocale },
      });
      toast.success(t('created', { name: name.trim() }));
      // A new active organisation: reload so every server read is scoped to it.
      window.location.assign('/welcome');
    } catch (err) {
      toast.error(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_1.2fr] md:gap-10">
      <div>
        <Building2 aria-hidden className="size-8 text-primary" strokeWidth={1.5} />
        <h2 className="mt-4 font-display text-3xl">{t('title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <form onSubmit={(e) => void submit(e)} className="grid gap-5">
        <div className="grid gap-1.5">
          <Label htmlFor="onb-org-name">{t('name')}</Label>
          <Input
            id="onb-org-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('namePlaceholder')}
            minLength={2}
            maxLength={80}
            required
            autoFocus
          />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="onb-org-country">{t('country')}</Label>
            <select
              id="onb-org-country"
              className={selectClass}
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              required
            >
              <option value="">{t('countryChoose')}</option>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t('countryHint')}</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="onb-org-locale">{t('language')}</Label>
            <select
              id="onb-org-locale"
              className={selectClass}
              value={defaultLocale}
              onChange={(e) => setDefaultLocale(e.target.value as typeof defaultLocale)}
            >
              {LOCALES.map((code) => (
                <option key={code} value={code} lang={code}>
                  {LOCALE_INFO[code].label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <Button type="submit" disabled={saving || name.trim().length < 2 || !country}>
            {saving && <Loader2 className="animate-spin" />}
            {t('submit')}
          </Button>
        </div>
      </form>
    </div>
  );
}

function NewBusinessForm() {
  const t = useTranslations('onboarding.business');
  const errorMessage = useErrorMessage();
  const { setBusinessId } = useBusiness();
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api<{ business: BusinessSummary }>(BUSINESSES_PATH, {
        method: 'POST',
        body: { name: name.trim(), ...(domain.trim() && { domain: domain.trim() }) },
      });
      setBusinessId(res.business.id);
      toast.success(t('created', { name: res.business.name }));
    } catch (err) {
      toast.error(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-5">
      <div className="grid gap-1.5">
        <Label htmlFor="onb-biz-name">{t('name')}</Label>
        <Input
          id="onb-biz-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('namePlaceholder')}
          maxLength={120}
          required
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="onb-biz-domain">{t('website')}</Label>
        <Input
          id="onb-biz-domain"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder={t('websitePlaceholder')}
          dir="ltr"
          inputMode="url"
          maxLength={253}
        />
        <p className="text-xs text-muted-foreground">{t('websiteHint')}</p>
      </div>
      <div>
        <Button type="submit" disabled={saving || !name.trim()}>
          {saving && <Loader2 className="animate-spin" />}
          {t('submit')}
        </Button>
      </div>
    </form>
  );
}

export function FirstBusinessStep() {
  const t = useTranslations('onboarding.business');
  const { setBusinessId } = useBusiness();
  const { data, error } = useApi<BusinessesResponse>(BUSINESSES_PATH);
  const existing = data?.data ?? [];

  // Core mode: Core owns the business list; keep the pre-Phase-18 pointer to /business.
  if (error instanceof ApiError && error.status === 501)
    return (
      <EmptyState
        icon={<Building2 className="size-8" strokeWidth={1.5} />}
        title={t('coreTitle')}
        description={t('coreDescription')}
        action={
          <Button asChild variant="outline">
            <Link href="/business">{t('coreAction')}</Link>
          </Button>
        }
      />
    );

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_1.2fr] md:gap-10">
      <div>
        <Globe2 aria-hidden className="size-8 text-primary" strokeWidth={1.5} />
        <h2 className="mt-4 font-display text-3xl">{t('title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('description')}</p>
      </div>
      {!data && !error ? (
        <Skeleton className="h-48 rounded-lg" aria-label={t('loading')} />
      ) : (
        <div className="grid gap-6">
          {existing.length > 0 && (
            <div className="grid gap-2">
              <p className="text-sm font-medium">{t('existing')}</p>
              <ul className="grid gap-2">
                {existing.map((b) => (
                  <li key={b.id}>
                    <Button
                      variant="outline"
                      className="w-full justify-start"
                      onClick={() => setBusinessId(b.id)}
                    >
                      <Building2 /> {b.name}
                      {b.domain && (
                        <span className="ms-auto text-xs text-muted-foreground" dir="ltr">
                          {b.domain}
                        </span>
                      )}
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">{t('orNew')}</p>
            </div>
          )}
          <NewBusinessForm />
        </div>
      )}
    </div>
  );
}
