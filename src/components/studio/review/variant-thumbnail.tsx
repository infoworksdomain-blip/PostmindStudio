'use client';

import { ImageIcon, Loader2, RefreshCw, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import type { Render } from '@/lib/client/types';

// 15.A3 — a variant's thumbnail with "Change" (spec 14.2 "thumbnail — editable inline"): pick a
// frame (with optional overlay text), regenerate from the library, or upload a JPEG/PNG.
// POST /renders/:id/thumbnail; YouTube publishes it with thumbnails.set.

export function VariantThumbnail({ render }: { render: Pick<Render, 'id' | 'durationSec'> }) {
  const { data, mutate } = useApi<{ render: { thumbnailUrl?: string | null } }>(
    `/renders/${render.id}`,
  );
  const [editing, setEditing] = useState(false);
  const [atSec, setAtSec] = useState('1');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const url = data?.render.thumbnailUrl ?? null;

  async function send(body: FormData | Record<string, unknown>) {
    setBusy(true);
    try {
      await api(`/renders/${render.id}/thumbnail`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body,
      });
      toast.success('Thumbnail updated.');
      setEditing(false);
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const frame = () =>
    send({
      source: 'keyframe',
      atSec: Math.min(render.durationSec, Math.max(0, Number(atSec) || 0)),
      ...(text.trim() && { overlayText: text.trim() }),
    });
  const regenerate = () =>
    send({ source: 'auto', ...(text.trim() && { overlayText: text.trim() }) });
  const upload = (file: File | undefined) => {
    if (!file) return;
    const form = new FormData();
    form.set('file', file);
    void send(form);
  };

  return (
    <section aria-label="Thumbnail" className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
          <img
            src={url}
            alt="Variant thumbnail"
            className="h-16 w-auto rounded border border-border"
          />
        ) : (
          <span className="grid h-16 w-16 place-items-center rounded border border-dashed border-border text-muted-foreground">
            <ImageIcon className="size-5" aria-label="No thumbnail yet" />
          </span>
        )}
        <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)}>
          Change
        </Button>
      </div>
      {editing && (
        <div className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs">
            Frame at (seconds)
            <Input
              type="number"
              min={0}
              max={render.durationSec}
              step={0.1}
              value={atSec}
              onChange={(e) => setAtSec(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Overlay text (optional)
            <Input value={text} maxLength={120} onChange={(e) => setText(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button size="sm" onClick={frame} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <ImageIcon />} Use this frame
            </Button>
            <Button size="sm" variant="outline" onClick={regenerate} disabled={busy}>
              <RefreshCw /> Regenerate
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              <Upload /> Upload
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              aria-label="Upload thumbnail"
              onChange={(e) => upload(e.target.files?.[0])}
            />
          </div>
        </div>
      )}
    </section>
  );
}
