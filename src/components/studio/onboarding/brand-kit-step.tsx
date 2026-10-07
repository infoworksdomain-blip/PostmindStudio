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
import { FontPicker, MAX_TONES, PaletteSwatches, ToneChips } from './brand-kit-options';

// Step 2 — a brand kit "in 3 clicks" (spec 14.5): upload a logo (the palette is extracted by
// POST /brand-kits/extract; nothing is stored until the kit is saved), pick a font, pick tone
// chips. Saving creates the kit, as the business's default when it has none yet.

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
      <div role="status" className="flex items-start gap-3 rounded-xl border border-border p-4">
        <CheckCircle2 className="mt-0.5 size-5 text-success" />
        <div>
          <p className="font-medium">{t('ready.title', { name: created.name })}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {created.isDefault ? t('ready.bodyDefault') : t('ready.body')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-display text-3xl">{t('title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('description')}</p>
      </div>
      {kits.error && <ErrorState error={kits.error} onRetry={() => void kits.mutate()} />}
      {existing.length > 0 && (
        <p className="text-sm text-muted-foreground">
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
          className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-4 py-3 text-sm hover:border-foreground/40 focus-within:ring-2 focus-within:ring-ring"
        >
          {extracting ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {t('uploadLogo')}
          <input
            id={logoId}
            type="file"
            accept={LOGO_TYPES.join(',')}
            onChange={(e) => void upload(e)}
            className="sr-only"
          />
        </label>
        {logoError && (
          <p role="alert" className="text-sm text-destructive">
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
        <legend className="mb-2 text-sm font-medium">{t('toneLegend', { max: MAX_TONES })}</legend>
        <ToneChips value={tones} onChange={setTones} />
      </fieldset>
      <div>
        <Button onClick={() => void save()} disabled={extracting} loading={saving}>
          {t('save')}
        </Button>
      </div>
    </div>
  );
}
