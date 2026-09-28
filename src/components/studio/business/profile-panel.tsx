'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { CircleAlert, Globe, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import { formatDate } from '@/lib/client/format';
import { EmptyState, ErrorState } from '../primitives';
import { parseList, type BusinessProfile, type ProfileListField } from './types';

// A6.8 — the LLM-classified business profile, editable. Edited profiles are kept across
// re-scans (editedByUser), so the save sends only the fields that changed.

const LIST_FIELDS: Array<{ key: ProfileListField; label: string; hint: string }> = [
  { key: 'products', label: 'Products', hint: 'What you sell' },
  { key: 'services', label: 'Services', hint: 'What you do for customers' },
  { key: 'audienceKeywords', label: 'Audience', hint: 'Who buys from you' },
  { key: 'toneIndicators', label: 'Tone', hint: 'How you sound' },
  { key: 'regions', label: 'Regions', hint: 'Where you trade' },
  { key: 'imageThemes', label: 'Image themes', hint: 'What your pictures should show' },
  {
    key: 'imageSearchQueries',
    label: 'Stock image searches',
    hint: 'Queries used to fill your image library (at least one)',
  },
  { key: 'restrictedTopics', label: 'Topics to avoid', hint: 'Never shown or mentioned' },
];

type Draft = Record<ProfileListField, string> & {
  industry: string;
  subNiche: string;
  brandVoiceSummary: string;
};

function toDraft(p: BusinessProfile): Draft {
  const lists = Object.fromEntries(LIST_FIELDS.map((f) => [f.key, p[f.key].join(', ')]));
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
  for (const { key } of LIST_FIELDS) {
    const next = parseList(d[key]);
    if (next.join('\n') !== p[key].join('\n')) changes[key] = next;
  }
  return changes;
}

function ProfileForm({ profile, onSaved }: { profile: BusinessProfile; onSaved: () => void }) {
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
      toast.success('Business profile saved');
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
          <Label htmlFor="profile-industry">Industry</Label>
          <Input
            id="profile-industry"
            value={draft.industry}
            maxLength={200}
            onChange={(e) => set('industry')(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="profile-subniche">Niche</Label>
          <Input
            id="profile-subniche"
            value={draft.subNiche}
            maxLength={200}
            onChange={(e) => set('subNiche')(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="profile-voice">Brand voice</Label>
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
        {LIST_FIELDS.map((f) => (
          <div key={f.key} className="grid gap-1.5">
            <Label htmlFor={`profile-${f.key}`}>{f.label}</Label>
            <Textarea
              id={`profile-${f.key}`}
              rows={2}
              value={draft[f.key]}
              aria-describedby={`profile-${f.key}-hint`}
              onChange={(e) => set(f.key)(e.target.value)}
            />
            <p id={`profile-${f.key}-hint`} className="text-xs text-muted-foreground">
              {f.hint} — separate with commas.
            </p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border/70 pt-5">
        <Button type="submit" disabled={!dirty || invalid || saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} Save profile
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!dirty || saving}
          onClick={() => setDraft(toDraft(profile))}
        >
          Discard changes
        </Button>
        {invalid && (
          <p className="text-xs text-destructive">
            Industry, niche and at least one stock image search are required.
          </p>
        )}
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
  const [busy, setBusy] = useState(false);
  const confidence =
    typeof profile.classifierConfidence === 'number'
      ? ` (confidence ${Math.round(profile.classifierConfidence * 100)}%)`
      : '';
  async function confirm() {
    setBusy(true);
    try {
      await api(`/businesses/${encodeURIComponent(profile.businessId)}/business-profile`, {
        method: 'PATCH',
        body: { confirmed: true },
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success('Business profile confirmed');
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
      aria-label="Profile needs your review"
      className="flex flex-wrap items-start gap-3 rounded-lg border border-warning/50 bg-warning/10 p-4"
    >
      <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-sm font-medium">Please confirm this profile</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Studio was not sure what your business does{confidence}. Check the details below, then
          confirm them or edit and save. Videos and image suggestions use this profile.
        </p>
      </div>
      <Button size="sm" disabled={busy} onClick={() => void confirm()}>
        {busy && <Loader2 className="animate-spin" />} Confirm profile
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
  const { data, error, isLoading, mutate } = useApi<{ profile: BusinessProfile }>(
    `/businesses/${encodeURIComponent(businessId)}/business-profile`,
  );

  if (isLoading) return <Skeleton aria-label="Loading profile" className="h-96 rounded-xl" />;
  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState
        icon={<Globe className="size-8" strokeWidth={1.5} />}
        title="No business profile yet"
        description="Scan your website and Studio works out what you sell, who for and which images suit you. You can edit everything afterwards."
        action={<Button onClick={onGoToScan}>Scan your website</Button>}
      />
    );
  }
  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (!data) return null;
  const { profile } = data;

  return (
    <div className="grid gap-8">
      <div className="border-l-2 border-primary pl-5">
        <p className="text-xs tracking-[0.18em] text-muted-foreground uppercase">
          What Studio thinks you do
        </p>
        <p className="mt-2 font-display text-3xl leading-tight md:text-4xl">
          {profile.subNiche} <span className="text-muted-foreground">in</span> {profile.industry}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {profile.editedByUser ? 'Edited by you' : `Classified by ${profile.classifierModel}`} ·
          refreshed {formatDate(profile.lastRefreshedAt)}
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
