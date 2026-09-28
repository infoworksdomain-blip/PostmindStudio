'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, RefreshCw, Upload, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { api, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import { NativeSelect } from '../publications/native-select';

// A6.3 / A6.6 / A6.8 — add to the library: upload a file (multipart), generate one from a
// prompt, or re-run the stock searches from the business profile.

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const ASPECTS = ['1:1', '9:16', '16:9', '4:5'] as const;

export function UploadImageButton({
  businessId,
  onAdded,
}: {
  businessId: string;
  onAdded: () => void;
}) {
  const t = useTranslations('business.images');
  const errorMessage = useErrorMessage();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error(t('tooLarge'));
      return;
    }
    const form = new FormData();
    form.set('businessId', businessId);
    form.set('file', file);
    setBusy(true);
    try {
      const res = await api<{ duplicate: boolean }>('/image-library', {
        method: 'POST',
        body: form,
      });
      toast.success(res.duplicate ? t('duplicate') : t('added'));
      onAdded();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
        className="sr-only"
        aria-label={t('fileAria')}
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <Loader2 className="animate-spin" /> : <Upload />} {t('upload')}
      </Button>
    </>
  );
}

export function RefreshLibraryButton({ businessId }: { businessId: string }) {
  const t = useTranslations('business.images');
  const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setBusy(true);
    try {
      const res = await api<{ queries: string[] }>('/image-library/refresh', {
        method: 'POST',
        body: { businessId },
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('refreshStarted', { count: res.queries.length }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>
      {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} {t('refresh')}
    </Button>
  );
}

export function GenerateImageButton({
  businessId,
  onAdded,
}: {
  businessId: string;
  onAdded: () => void;
}) {
  const t = useTranslations('business.images');
  const errorMessage = useErrorMessage();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState('');
  const [aspect, setAspect] = useState<(typeof ASPECTS)[number]>('1:1');
  const [busy, setBusy] = useState(false);
  const valid = prompt.trim().length >= 3;

  async function generate() {
    setBusy(true);
    try {
      await api('/image-library/generate', {
        method: 'POST',
        body: {
          businessId,
          prompt: prompt.trim(),
          ...(style.trim() && { style: style.trim() }),
          aspectRatio: aspect,
        },
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('generated'));
      setOpen(false);
      setPrompt('');
      onAdded();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Wand2 /> {t('generate')}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('generateTitle')}</DialogTitle>
          <DialogDescription>{t('generateDescription')}</DialogDescription>
        </DialogHeader>
        <form
          id="generate-image-form"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void generate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="generate-prompt">{t('prompt')}</Label>
            <Textarea
              id="generate-prompt"
              rows={3}
              maxLength={1000}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div className="grid gap-1.5">
              <Label htmlFor="generate-style">{t('style')}</Label>
              <Input
                id="generate-style"
                maxLength={200}
                value={style}
                onChange={(e) => setStyle(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="generate-aspect">{t('shape')}</Label>
              <NativeSelect
                id="generate-aspect"
                value={aspect}
                onChange={(e) => setAspect(e.target.value as (typeof ASPECTS)[number])}
              >
                {ASPECTS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="generate-image-form" disabled={!valid || busy}>
            {busy && <Loader2 className="animate-spin" />} {t('generate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
