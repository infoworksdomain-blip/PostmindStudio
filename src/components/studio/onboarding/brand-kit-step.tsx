'use client';

import { useEffect, useId, useState, type ChangeEvent } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { BrandKit } from '@/lib/client/types';
import { ErrorState } from '../primitives';
import Link from 'next/link';
import {
  FontPicker,
  MAX_TONES,
  PaletteSwatches,
  TONE_KEY,
  ToneChips,
  type Tone,
} from './brand-kit-options';
import { BrandPreview } from './brand-preview';

// Step 2 — a brand kit "in 3 clicks" (spec 14.5): upload a logo (the palette is extracted by
// POST /brand-kits/extract; nothing is stored until the kit is saved), pick a font, pick tone
// chips. Saving creates the kit, as the business's default when it has none yet.
// 25.6: a live preview beside the pickers (colours, font and tone as one title card), and a quiet
// pointer to the website scan on the Business page (A6.1) for people who would rather start there.

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
const MAX_LOGO_MB = 5;
const MAX_LOGO_BYTES = MAX_LOGO_MB * 1024 * 1024;

type LogoProblem = 'logoType' | 'logoSize';

function logoProblem(file: File): LogoProblem | null {
  if (!LOGO_TYPES.includes(file.type)) return 'logoType';
  if (file.size > MAX_LOGO_BYTES) return 'logoSize';
  return null;
}

export function BrandKitStep({
  businessId,
  onReady,
}: {
  businessId: string;
  onReady: (ready: boolean) => void;
}) {
  const t = useTranslations('onboarding.brandKit');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const logoId = useId();
  const kits = useApi<{ data: BrandKit[] }>('/brand-kits', { businessId });
  const [palette, setPalette] = useState<string[]>([]);
  const [font, setFont] = useState<string | null>(null);
  const [tones, setTones] = useState<string[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<BrandKit | null>(null);

  const existing = kits.data?.data ?? [];
  const hasKit = created !== null || existing.length > 0;
  useEffect(() => onReady(hasKit), [hasKit, onReady]);

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const problem = logoProblem(file);
    setLogoError(problem && t(problem, { max: MAX_LOGO_MB }));
    if (problem) return;
    const form = new FormData();
    form.append('logo', file);
    setExtracting(true);
    try {
      const res = await api<{ palette: string[] }>('/brand-kits/extract', {
        method: 'POST',
        body: form,
      });
      setPalette(res.palette);
    } catch (err) {
      setLogoError(errorMessage(err));
    } finally {
      setExtracting(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const { brandKit } = await api<{ brandKit: BrandKit }>('/brand-kits', {
        method: 'POST',
        body: {
          businessId,
          name: t('defaultKitName'),
          colourPalette: palette,
          fontPrimary: font,
          toneKeywords: tones.map((tone) => tone.toLowerCase()),
          isDefault: existing.length === 0,
        },
        idempotencyKey: newIdempotencyKey(),
      });
      setCreated(brandKit);
      toast.success(t('saved'));
      void kits.mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (created) {
    return (
      <div role="status" className="flex items-start gap-3 rounded-panel bg-success-soft p-5">
        <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-success-foreground" />
        <div>
          <p className="font-medium">{t('ready.title', { name: created.name })}</p>
          <p className="mt-1 text-sm text-foreground-secondary">
            {created.isDefault ? t('ready.bodyDefault') : t('ready.body')}
          </p>
        </div>
      </div>
    );
  }

  const toneText = f.list(
    tones.map((tone) => (tone in TONE_KEY ? t(`tones.${TONE_KEY[tone as Tone]}`) : tone)),
  );
  const logoErrorId = `${logoId}-error`;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-12">
      <div className="flex min-w-0 flex-col gap-7">
        <div>
          <h2 className="font-display text-2xl leading-tight sm:text-[1.75rem]">{t('title')}</h2>
          <p className="mt-2 text-[0.9375rem] leading-relaxed text-foreground-secondary">
            {t('description')}
          </p>
        </div>
        {kits.error && <ErrorState error={kits.error} onRetry={() => void kits.mutate()} />}
        {existing.length > 0 && (
          <p className="rounded-field bg-surface-raised px-3.5 py-3 text-sm text-foreground-secondary">
            {t('existing', {
              count: existing.length,
              names: f.list(existing.map((k) => k.name)),
            })}
          </p>
        )}
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-medium">{t('logoLegend')}</legend>
          <label
            htmlFor={logoId}
            className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-field border border-dashed border-border-strong px-4 py-3 text-sm transition-colors duration-(--duration-fast) focus-within:ring-2 focus-within:ring-ring hover:border-foreground/40 hover:bg-surface-raised"
          >
            {extracting ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <Upload aria-hidden className="size-4" />
            )}
            {t('uploadLogo')}
            <input
              id={logoId}
              type="file"
              accept={LOGO_TYPES.join(',')}
              onChange={(e) => void upload(e)}
              aria-invalid={logoError ? true : undefined}
              aria-describedby={logoError ? logoErrorId : undefined}
              className="sr-only"
            />
          </label>
          {logoError && (
            <p id={logoErrorId} role="alert" className="text-sm text-destructive-foreground">
              {logoError}
            </p>
          )}
          {palette.length > 0 && (
            <PaletteSwatches
              colours={palette}
              onRemove={(c) => setPalette((p) => p.filter((x) => x !== c))}
            />
          )}
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('fontLegend')}</legend>
          <FontPicker value={font} onChange={setFont} />
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">
            {t('toneLegend', { max: MAX_TONES })}
          </legend>
          <ToneChips value={tones} onChange={setTones} />
        </fieldset>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <Button onClick={() => void save()} disabled={extracting} loading={saving}>
            {t('save')}
          </Button>
          <Link
            href="/business"
            className="rounded-control text-sm text-foreground-secondary underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {t('scanWebsite')}
          </Link>
        </div>
      </div>
      <div className="lg:sticky lg:top-6 lg:self-start">
        <BrandPreview palette={palette} font={font} tones={toneText} />
      </div>
    </div>
  );
}
