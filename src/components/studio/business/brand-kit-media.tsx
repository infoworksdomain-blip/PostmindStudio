'use client';

import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, ImagePlus, Loader2, Type, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api, ApiError, errorMessage, newIdempotencyKey } from '@/lib/client/api';
import type { BrandKit } from '@/lib/client/types';

// BACKLOG 15.B1 — a brand kit's media (spec 10.1): logo (PNG with transparency), watermark,
// intro and outro cards, and an uploaded font (A11.5: the owner confirms the licence allows
// commercial embedding). Each file goes through the 13.5 presigned-PUT flow (POST /uploads →
// PUT → /uploads/:id/complete) and is then saved on the kit with PATCH /brand-kits/:id.
// Operator decision P6: the optional on-video "AI-generated" label is switched here too.

export type BrandMediaKind = 'brand_logo' | 'brand_watermark' | 'brand_card' | 'brand_font';

type MediaField = 'logoAssetId' | 'watermarkAssetId' | 'introCardAssetId' | 'outroCardAssetId';

const SLOTS: Array<{ field: MediaField; kind: BrandMediaKind; label: string; accept: string }> = [
  { field: 'logoAssetId', kind: 'brand_logo', label: 'Logo', accept: 'image/png' },
  { field: 'watermarkAssetId', kind: 'brand_watermark', label: 'Watermark', accept: 'image/png' },
  {
    field: 'introCardAssetId',
    kind: 'brand_card',
    label: 'Intro card',
    accept: 'image/png,image/jpeg,video/mp4',
  },
  {
    field: 'outroCardAssetId',
    kind: 'brand_card',
    label: 'Outro card',
    accept: 'image/png,image/jpeg,video/mp4',
  },
];

const FONT_TYPES: Record<string, string> = { ttf: 'font/ttf', otf: 'font/otf' };

/** The content type to declare for a file (fonts often arrive without one). */
export function brandContentType(file: { name: string; type: string }): string {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return FONT_TYPES[ext] ?? file.type;
}

export async function uploadBrandFile(
  file: File,
  target: { kind: BrandMediaKind; businessId: string; licenceConfirmed?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; fontFamily: string | null }> {
  const contentType = brandContentType(file);
  const { upload } = await api<{
    upload: { id: string; putUrl: string; headers: Record<string, string> };
  }>('/uploads', {
    method: 'POST',
    body: {
      kind: target.kind,
      contentType,
      sizeBytes: file.size,
      fileName: file.name.slice(0, 200) || 'file',
      businessId: target.businessId,
      ...(target.kind === 'brand_font' && { licenceConfirmed: target.licenceConfirmed === true }),
    },
    idempotencyKey: newIdempotencyKey(),
  });
  const put = await fetchImpl(upload.putUrl, {
    method: 'PUT',
    headers: upload.headers,
    body: file,
  });
  if (!put.ok) throw new ApiError(put.status, 'upload_failed', 'The upload to storage failed.');
  const done = await api<{ upload: { id: string; fontFamily: string | null } }>(
    `/uploads/${upload.id}/complete`,
    { method: 'POST', idempotencyKey: newIdempotencyKey() },
  );
  return { id: done.upload.id, fontFamily: done.upload.fontFamily ?? null };
}

async function patchKit(kit: Pick<BrandKit, 'id'>, body: Record<string, unknown>) {
  await api(`/brand-kits/${encodeURIComponent(kit.id)}`, {
    method: 'PATCH',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

function MediaSlot({
  kit,
  slot,
  onSaved,
}: {
  kit: BrandKit;
  slot: (typeof SLOTS)[number];
  onSaved: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const current = kit[slot.field] ?? null;

  async function run(work: () => Promise<void>, success: string) {
    setBusy(true);
    try {
      await work();
      toast.success(success);
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <li className="flex items-center gap-2 text-sm">
      <span className="w-20 shrink-0 text-muted-foreground">{slot.label}</span>
      <span className="min-w-0 flex-1 truncate">
        {current ? (
          <span className="inline-flex items-center gap-1">
            <Check className="size-3.5 text-success" aria-hidden /> Added
          </span>
        ) : (
          <span className="text-muted-foreground">None</span>
        )}
      </span>
      <input
        ref={input}
        id={id}
        type="file"
        className="sr-only"
        accept={slot.accept}
        aria-label={`Upload ${slot.label.toLowerCase()} for ${kit.name}`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          void run(async () => {
            const up = await uploadBrandFile(file, { kind: slot.kind, businessId: kit.businessId });
            await patchKit(kit, { [slot.field]: up.id });
          }, `${slot.label} saved`);
        }}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => input.current?.click()}
        aria-label={`${current ? 'Replace' : 'Add'} ${slot.label.toLowerCase()}`}
      >
        {busy ? <Loader2 className="animate-spin" /> : <ImagePlus />}
        {current ? 'Replace' : 'Add'}
      </Button>
      {current && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-label={`Remove ${slot.label.toLowerCase()}`}
          onClick={() =>
            void run(() => patchKit(kit, { [slot.field]: null }), `${slot.label} removed`)
          }
        >
          <X />
        </Button>
      )}
    </li>
  );
}

function FontUpload({ kit, onSaved }: { kit: BrandKit; onSaved: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const licenceId = useId();
  const [licence, setLicence] = useState(false);
  const [busy, setBusy] = useState(false);
  const uploaded = kit.fontPrimary?.startsWith('upload:') ?? false;

  async function upload(file: File) {
    setBusy(true);
    try {
      const up = await uploadBrandFile(file, {
        kind: 'brand_font',
        businessId: kit.businessId,
        licenceConfirmed: licence,
      });
      await patchKit(kit, { fontPrimary: `upload:${up.id}` });
      toast.success(`${up.fontFamily ?? 'Font'} is now the heading font`);
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <li className="flex flex-col gap-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="w-20 shrink-0 text-muted-foreground">Font</span>
        <span className="min-w-0 flex-1 truncate">
          {uploaded ? 'Uploaded font' : (kit.fontPrimary ?? 'Default')}
        </span>
        <input
          ref={input}
          type="file"
          className="sr-only"
          accept=".ttf,.otf,font/ttf,font/otf"
          aria-label={`Upload font for ${kit.name}`}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !licence}
          onClick={() => input.current?.click()}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Type />}
          Upload TTF/OTF
        </Button>
      </div>
      <label
        htmlFor={licenceId}
        className="flex items-start gap-2 pl-22 text-xs text-muted-foreground"
      >
        <input
          id={licenceId}
          type="checkbox"
          className="mt-0.5"
          checked={licence}
          onChange={(e) => setLicence(e.target.checked)}
        />
        I confirm this font’s licence allows embedding it in commercial videos.
      </label>
    </li>
  );
}

export function BrandKitMedia({ kit, onSaved }: { kit: BrandKit; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const labelId = useId();

  async function toggleLabel(next: boolean) {
    setBusy(true);
    try {
      await patchKit(kit, { aiDisclosureLabel: next });
      toast.success(next ? 'AI-generated label on' : 'AI-generated label off');
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={`Media for ${kit.name}`} className="flex flex-col gap-2 border-t pt-3">
      <ul className="flex flex-col gap-2">
        {SLOTS.map((slot) => (
          <MediaSlot key={slot.field} kit={kit} slot={slot} onSaved={onSaved} />
        ))}
        <FontUpload kit={kit} onSaved={onSaved} />
      </ul>
      <label htmlFor={labelId} className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          id={labelId}
          checked={kit.aiDisclosureLabel ?? false}
          disabled={busy}
          onCheckedChange={(v) => void toggleLabel(v)}
          aria-label="Show an AI-generated label on videos"
        />
        Show an “AI-generated” label on videos (platform AI labels are always on)
      </label>
    </section>
  );
}
