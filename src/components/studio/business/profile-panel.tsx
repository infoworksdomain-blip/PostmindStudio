'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CircleAlert, Globe, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState } from '../primitives';
import { parseList, type BusinessProfile, type ProfileListField } from './types';

// A6.8 — the LLM-classified business profile, editable. Edited profiles are kept across
// re-scans (editedByUser), so the save sends only the fields that changed.

/** Editable list fields, in form order (labels and hints: business.profile.fields.*). */
const LIST_FIELDS: readonly ProfileListField[] = [
  'products',
  'services',
  'audienceKeywords',
  'toneIndicators',
  'regions',
  'imageThemes',
  'imageSearchQueries',
  'restrictedTopics',
];

type Draft = Record<ProfileListField, string> & {
  industry: string;
  subNiche: string;
  brandVoiceSummary: string;
};

function toDraft(p: BusinessProfile): Draft {
  const lists = Object.fromEntries(LIST_FIELDS.map((key) => [key, p[key].join(', ')]));
  return {
    ...(lists as Record<ProfileListField, string>),
    industry: p.industry,
    subNiche: p.subNiche,
    brandVoiceSummary: p.brandVoiceSummary ?? '',
  };
}

/** Only the fields that differ from the saved profile, in the PATCH body's shape. */
export function profileChanges(p: BusinessProfile, d: Draft): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (d.industry.trim() !== p.industry) changes.industry = d.industry.trim();
  if (d.subNiche.trim() !== p.subNiche) changes.subNiche = d.subNiche.trim();
  const voice = d.brandVoiceSummary.trim() || null;
  if (voice !== (p.brandVoiceSummary ?? null)) changes.brandVoiceSummary = voice;
  for (const key of LIST_FIELDS) {
    const next = parseList(d[key]);
    if (next.join('\n') !== p[key].join('\n')) changes[key] = next;
  }
  return changes;
}

function ProfileForm({ profile, onSaved }: { profile: BusinessProfile; onSaved: () => void }) {
  const t = useTranslations('business.profile');
  const errorMessage = useErrorMessage();
  const [draft, setDraft] = useState(() => toDraft(profile));
  const [saving, setSaving] = useState(false);
  const changes = profileChanges(profile, draft);
  const dirty = Object.keys(changes).length > 0;
  const invalid =
    !draft.industry.trim() ||
    !draft.subNiche.trim() ||
    parseList(draft.imageSearchQueries).length === 0;

  async function save() {
    setSaving(true);
    try {
      await api(`/businesses/${encodeURIComponent(profile.businessId)}/business-profile`, {
        method: 'PATCH',
        body: changes,
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('saved'));
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const set = (key: keyof Draft) => (value: string) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <form
      className="grid gap-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !invalid) void save();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="profile-industry">{t('industry')}</Label>
          <Input
            id="profile-industry"
            value={draft.industry}
            maxLength={200}
            onChange={(e) => set('industry')(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="profile-subniche">{t('niche')}</Label>
          <Input
            id="profile-subniche"
            value={draft.subNiche}
            maxLength={200}
            onChange={(e) => set('subNiche')(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="profile-voice">{t('brandVoice')}</Label>
          <Textarea
            id="profile-voice"
            rows={3}
            maxLength={1000}
            value={draft.brandVoiceSummary}
            onChange={(e) => set('brandVoiceSummary')(e.target.value)}
          />
        </div>
      </div>
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
        {LIST_FIELDS.map((key) => (
          <div key={key} className="grid gap-1.5">
            <Label htmlFor={`profile-${key}`}>{t(`fields.${key}.label`)}</Label>
            <Textarea
              id={`profile-${key}`}
              rows={2}
              value={draft[key]}
              aria-describedby={`profile-${key}-hint`}
              onChange={(e) => set(key)(e.target.value)}
            />
            <p id={`profile-${key}-hint`} className="text-xs text-muted-foreground">
              {t(`fields.${key}.hint`)}
            </p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border/70 pt-5">
        <Button type="submit" disabled={!dirty || invalid || saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} {t('save')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!dirty || saving}
          onClick={() => setDraft(toDraft(profile))}
        >
          {t('discard')}
        </Button>
        {invalid && <p className="text-xs text-destructive">{t('invalid')}</p>}
      </div>
    </form>
  );
}

/**
 * 15.D8 / A13 — "low-confidence classifications flagged for user review before use". Confirming
 * (or saving an edit) clears the flag; until then the profile is still used, with this warning.
 */
export function ProfileReviewBanner({
  profile,
  onConfirmed,
}: {
  profile: BusinessProfile;
  onConfirmed: () => void;
}) {
  const t = useTranslations('business.profile.review');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try {
      await api(`/businesses/${encodeURIComponent(profile.businessId)}/business-profile`, {
        method: 'PATCH',
        body: { confirmed: true },
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('confirmed'));
      onConfirmed();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      role="status"
      aria-label={t('aria')}
      className="flex flex-wrap items-start gap-3 rounded-lg border border-warning/50 bg-warning/10 p-4"
    >
      <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-sm font-medium">{t('title')}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {typeof profile.classifierConfidence === 'number'
            ? t('bodyConfidence', { percent: f.percent(profile.classifierConfidence) })
            : t('body')}
        </p>
      </div>
      <Button size="sm" disabled={busy} onClick={() => void confirm()}>
        {busy && <Loader2 className="animate-spin" />} {t('confirm')}
      </Button>
    </div>
  );
}

export function ProfilePanel({
  businessId,
  onGoToScan,
}: {
  businessId: string;
  onGoToScan: () => void;
}) {
  const t = useTranslations('business.profile');
  const f = useFormat();
  const { data, error, isLoading, mutate } = useApi<{ profile: BusinessProfile }>(
    `/businesses/${encodeURIComponent(businessId)}/business-profile`,
  );

  if (isLoading) return <Skeleton aria-label={t('loading')} className="h-96 rounded-xl" />;
  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState
        icon={<Globe className="size-8" strokeWidth={1.5} />}
        title={t('empty.title')}
        description={t('empty.body')}
        action={<Button onClick={onGoToScan}>{t('empty.action')}</Button>}
      />
    );
  }
  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (!data) return null;
  const { profile } = data;

  return (
    <div className="grid gap-8">
      <div className="border-s-2 border-primary ps-5">
        <p className="text-xs tracking-[0.18em] text-muted-foreground uppercase">{t('eyebrow')}</p>
        <p className="mt-2 font-display text-3xl leading-tight md:text-4xl">
          {t.rich('headline', {
            niche: profile.subNiche,
            industry: profile.industry,
            muted: (chunks) => <span className="text-muted-foreground">{chunks}</span>,
          })}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {profile.editedByUser
            ? t('editedByYou', { date: f.date(profile.lastRefreshedAt) })
            : t('classifiedBy', {
                model: profile.classifierModel,
                date: f.date(profile.lastRefreshedAt),
              })}
        </p>
      </div>
      {profile.needsReview && (
        <ProfileReviewBanner profile={profile} onConfirmed={() => void mutate()} />
      )}
      <ProfileForm
        key={profile.id + profile.lastRefreshedAt}
        profile={profile}
        onSaved={() => void mutate()}
      />
    </div>
  );
}
