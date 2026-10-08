'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { api, useApi } from '@/lib/client/api';
import { LOCALE_INFO, LOCALES } from '@/lib/i18n/locales';
import { hardNavigate, hardReload } from '@/lib/client/navigate';
import { ErrorState, PageHeader, Section } from '../primitives';
import { countryOptions } from './countries';
import { DangerRow, DangerZone } from './danger-zone';
import type { MembersResponse } from './members-screen';
import { useSettingsError } from './settings-errors';

// Phase 18 §3 /settings/organisation — details (name, logo, country for tax, default locale),
// transfer of ownership (owner) and deletion (owner; type the name to confirm). PATCH /org,
// POST /org/transfer-ownership, DELETE /org.

export interface OrganisationSettings {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  country: string | null;
  defaultLocale: string | null;
  createdAt: string;
  yourRole: string | null;
}

export interface OrganisationResponse {
  ok: true;
  organisation: OrganisationSettings;
}

const canManage = (role: string | null) => role === 'owner' || role === 'admin';

function DetailsForm({
  org,
  onSaved,
}: {
  org: OrganisationSettings;
  onSaved: (org: OrganisationSettings) => void;
}) {
  const t = useTranslations('orgSettings.details');
  const tc = useTranslations('common.actions');
  const locale = useLocale();
  const errorMessage = useSettingsError();
  const countries = useMemo(() => countryOptions(locale), [locale]);
  const [name, setName] = useState(org.name);
  const [logo, setLogo] = useState(org.logo ?? '');
  const [country, setCountry] = useState(org.country ?? '');
  const [defaultLocale, setDefaultLocale] = useState(org.defaultLocale ?? '');
  const [saving, setSaving] = useState(false);
  const editable = canManage(org.yourRole);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api<OrganisationResponse>('/org', {
        method: 'PATCH',
        body: {
          name: name.trim(),
          logo: logo.trim() || null,
          country: country || null,
          defaultLocale: defaultLocale || null,
        },
      });
      onSaved(res.organisation);
      toast.success(t('saved'));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title={t('title')} description={editable ? t('description') : t('readOnly')}>
      <form onSubmit={(e) => void submit(e)} className="grid max-w-xl gap-5">
        <div className="grid gap-1.5">
          <Label htmlFor="org-name">{t('name')}</Label>
          <Input
            id="org-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={2}
            maxLength={80}
            required
            disabled={!editable}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="org-logo">{t('logo')}</Label>
          <Input
            id="org-logo"
            type="url"
            inputMode="url"
            dir="ltr"
            value={logo}
            onChange={(e) => setLogo(e.target.value)}
            placeholder={t('logoPlaceholder')}
            disabled={!editable}
          />
          <p className="text-xs text-muted-foreground">{t('logoHint')}</p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="org-country">{t('country')}</Label>
            <NativeSelect
              id="org-country"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              disabled={!editable}
            >
              <option value="">{t('countryNone')}</option>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">{t('countryHint')}</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="org-locale">{t('defaultLocale')}</Label>
            <NativeSelect
              id="org-locale"
              value={defaultLocale}
              onChange={(e) => setDefaultLocale(e.target.value)}
              disabled={!editable}
            >
              <option value="">{t('localeNone')}</option>
              {LOCALES.map((code) => (
                <option key={code} value={code} lang={code}>
                  {LOCALE_INFO[code].label}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        {editable && (
          <div>
            <Button type="submit" disabled={name.trim().length < 2} loading={saving}>
              {tc('save')}
            </Button>
          </div>
        )}
      </form>
    </Section>
  );
}

/**
 * §5.11: deletion and ownership transfer ask for the current password (the API re-checks it).
 * Google-only accounts have none: they leave it blank and must have signed in recently.
 */
function ReauthPasswordField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const t = useTranslations('orgSettings.reauth');
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{t('password')}</Label>
      <Input
        id={id}
        type="password"
        autoComplete="current-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {t('hint')}
      </p>
    </div>
  );
}

/** The request body's password, omitted when blank (Google-only accounts). */
function withPassword<T extends Record<string, unknown>>(body: T, password: string) {
  return password ? { ...body, password } : body;
}

function TransferOwnership() {
  const t = useTranslations('orgSettings.transfer');
  const errorMessage = useSettingsError();
  const { data } = useApi<MembersResponse>('/members');
  const [memberId, setMemberId] = useState('');
  const [password, setPassword] = useState('');
  const [open, setOpen] = useState(false);
  const candidates = data?.members.filter((m) => !m.isYou) ?? [];
  const chosen = candidates.find((m) => m.id === memberId);

  async function transfer(): Promise<boolean> {
    try {
      await api('/org/transfer-ownership', {
        method: 'POST',
        body: withPassword({ memberId }, password),
      });
      toast.success(t('done', { name: chosen?.name ?? '' }));
      hardReload();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  }

  return (
    <DangerRow
      title={t('title')}
      description={t('description')}
      action={
        candidates.length > 0 ? (
          <Button variant="outline" disabled={!chosen} onClick={() => setOpen(true)}>
            {t('action')}
          </Button>
        ) : undefined
      }
    >
      {candidates.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('nobody')}</p>
      ) : (
        <div className="mt-3 grid max-w-sm gap-1.5">
          <Label htmlFor="transfer-to">{t('to')}</Label>
          <NativeSelect
            id="transfer-to"
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
          >
            <option value="">{t('choose')}</option>
            {candidates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.email}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setPassword('');
        }}
        title={t('confirmTitle')}
        description={t('confirmBody', { name: chosen?.name ?? '' })}
        confirmLabel={t('action')}
        onConfirm={transfer}
      >
        <ReauthPasswordField id="transfer-password" value={password} onChange={setPassword} />
      </ConfirmDialog>
    </DangerRow>
  );
}

function DeleteOrganisation({ org }: { org: OrganisationSettings }) {
  const t = useTranslations('orgSettings.delete');
  const errorMessage = useSettingsError();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');

  async function remove(): Promise<boolean> {
    try {
      await api('/org', { method: 'DELETE', body: withPassword({ confirmName: typed }, password) });
      toast.success(t('done'));
      hardNavigate('/');
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  }

  return (
    <DangerRow
      title={t('title')}
      description={t('description')}
      action={
        <Button variant="destructive" onClick={() => setOpen(true)}>
          {t('action')}
        </Button>
      }
    >
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setTyped('');
            setPassword('');
          }
        }}
        title={t('confirmTitle', { name: org.name })}
        description={t('confirmBody')}
        confirmLabel={t('confirm')}
        confirmDisabled={typed.trim() !== org.name}
        onConfirm={remove}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="org-delete-confirm">{t('typeName', { name: org.name })}</Label>
          <Input
            id="org-delete-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </div>
        <ReauthPasswordField id="org-delete-password" value={password} onChange={setPassword} />
      </ConfirmDialog>
    </DangerRow>
  );
}

export function OrganisationSettingsScreen() {
  const t = useTranslations('orgSettings.page');
  const tn = useTranslations('settingsNav');
  const { data, error, mutate } = useApi<OrganisationResponse>('/org');
  const [org, setOrg] = useState<OrganisationSettings | null>(null);
  useEffect(() => {
    if (data) setOrg(data.organisation);
  }, [data]);

  return (
    <>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')} />
      {error ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : !org ? (
        <Skeleton className="h-72 rounded-xl" aria-label={t('loading')} />
      ) : (
        <div className="grid gap-10">
          <DetailsForm key={org.id} org={org} onSaved={setOrg} />
          {org.yourRole === 'owner' && (
            <DangerZone title={tn('dangerZone')} description={tn('dangerZoneHint')}>
              <TransferOwnership />
              <DeleteOrganisation org={org} />
            </DangerZone>
          )}
        </div>
      )}
    </>
  );
}
