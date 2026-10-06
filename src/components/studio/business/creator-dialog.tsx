'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, newIdempotencyKey } from '@/lib/client/api';
import { UGC_AGE_RANGES, UGC_GENDERS, UGC_SETTINGS } from '../create/ugc-options';
import { Field, NativeSelect } from '../review/field';
import {
  creatorsPath,
  MAX_PHOTO_BYTES,
  useCreatorErrorMessage,
  type Creator,
} from '../creators/types';

// BACKLOG 22.3 — a new creator: generated from the presets and look notes (a fictional person,
// through Studio's own image generation), or from an uploaded photo ONLY with the attestation
// that the uploader has the person's consent and the rights (the server stores who and when).

type Mode = 'generate' | 'upload';

interface Draft {
  mode: Mode;
  name: string;
  gender: Creator['gender'];
  ageRange: Creator['ageRange'];
  setting: Creator['setting'];
  appearance: string;
  voiceTone: string;
  photo: File | null;
  consent: boolean;
}

type Problem = 'name' | 'photo' | 'photoType' | 'photoSize' | 'consent';

export function draftProblem(d: Draft): Problem | null {
  if (!d.name.trim()) return 'name';
  if (d.mode === 'generate') return null;
  if (!d.photo) return 'photo';
  if (!['image/png', 'image/jpeg'].includes(d.photo.type)) return 'photoType';
  if (d.photo.size > MAX_PHOTO_BYTES) return 'photoSize';
  if (!d.consent) return 'consent';
  return null;
}

function fields(d: Draft) {
  return {
    name: d.name.trim(),
    gender: d.gender,
    ageRange: d.ageRange,
    setting: d.setting,
    ...(d.appearance.trim() && { appearance: d.appearance.trim() }),
    ...(d.voiceTone.trim() && { voiceTone: d.voiceTone.trim() }),
  };
}

function uploadForm(d: Draft): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields(d))) form.set(k, v);
  form.set('consent', 'true');
  if (d.photo) form.set('photo', d.photo);
  return form;
}

export function CreatorDialog({
  open,
  onOpenChange,
  businessId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  businessId: string;
  onCreated: (creator: Creator) => void;
}) {
  const t = useTranslations('business.creators.dialog');
  const tu = useTranslations('create.ugc');
  const creatorError = useCreatorErrorMessage();
  const [draft, setDraft] = useState<Draft>({
    mode: 'generate',
    name: '',
    gender: 'woman',
    ageRange: '25-34',
    setting: 'kitchen',
    appearance: '',
    voiceTone: '',
    photo: null,
    consent: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = draftProblem(draft);
  const set = (next: Partial<Draft>) => setDraft((d) => ({ ...d, ...next }));

  async function submit() {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const path = creatorsPath(businessId);
      const res = await api<{ creator: Creator }>(
        draft.mode === 'upload' ? `${path}/upload` : path,
        {
          method: 'POST',
          body: draft.mode === 'upload' ? uploadForm(draft) : fields(draft),
          idempotencyKey: newIdempotencyKey(),
        },
      );
      onCreated(res.creator);
      onOpenChange(false);
    } catch (err) {
      setError(creatorError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form
          id="creator-form"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div role="radiogroup" aria-label={t('modeAria')} className="grid grid-cols-2 gap-2">
            {(['generate', 'upload'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={draft.mode === mode}
                onClick={() => set({ mode })}
                className={`rounded-xl border px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                  draft.mode === mode
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border hover:bg-muted'
                }`}
              >
                {mode === 'generate' ? t('modeGenerate') : t('modeUpload')}
              </button>
            ))}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="creator-name">{t('name')}</Label>
            <Input
              id="creator-name"
              maxLength={60}
              placeholder={t('namePlaceholder')}
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field id="creator-gender" label={tu('gender')}>
              <NativeSelect
                id="creator-gender"
                value={draft.gender}
                onChange={(e) => set({ gender: e.target.value as Draft['gender'] })}
              >
                {UGC_GENDERS.map((g) => (
                  <option key={g} value={g}>
                    {tu(`genders.${g}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="creator-age" label={tu('age')}>
              <NativeSelect
                id="creator-age"
                value={draft.ageRange}
                onChange={(e) => set({ ageRange: e.target.value as Draft['ageRange'] })}
              >
                {UGC_AGE_RANGES.map((a) => (
                  <option key={a} value={a}>
                    {tu(`ages.${a}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="creator-setting" label={tu('setting')}>
              <NativeSelect
                id="creator-setting"
                value={draft.setting}
                onChange={(e) => set({ setting: e.target.value as Draft['setting'] })}
              >
                {UGC_SETTINGS.map((s) => (
                  <option key={s} value={s}>
                    {tu(`settings.${s}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="creator-appearance">{t('appearance')}</Label>
            <Textarea
              id="creator-appearance"
              rows={2}
              maxLength={300}
              placeholder={t('appearancePlaceholder')}
              value={draft.appearance}
              onChange={(e) => set({ appearance: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="creator-voice">{t('voiceTone')}</Label>
            <Input
              id="creator-voice"
              maxLength={120}
              placeholder={t('voiceTonePlaceholder')}
              value={draft.voiceTone}
              onChange={(e) => set({ voiceTone: e.target.value })}
            />
          </div>
          {draft.mode === 'generate' ? (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} aria-hidden />
              {t('generateNote')}
            </p>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="creator-photo">{t('photo')}</Label>
                <Input
                  id="creator-photo"
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={(e) => set({ photo: e.target.files?.[0] ?? null })}
                />
              </div>
              <div className="flex items-start gap-2">
                <Checkbox
                  id="creator-consent"
                  checked={draft.consent}
                  onCheckedChange={(v) => set({ consent: v === true })}
                />
                <Label htmlFor="creator-consent" className="text-sm leading-snug font-normal">
                  {t('consent')}
                </Label>
              </div>
            </>
          )}
          {problem && problem !== 'name' && (
            <p className="text-xs text-muted-foreground">{t(`problems.${problem}`)}</p>
          )}
          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            form="creator-form"
            disabled={Boolean(problem) || busy}
            title={problem ? t(`problems.${problem}`) : undefined}
          >
            {busy && <Loader2 className="animate-spin" />}
            {draft.mode === 'generate' ? t('submitGenerate') : t('submitUpload')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
