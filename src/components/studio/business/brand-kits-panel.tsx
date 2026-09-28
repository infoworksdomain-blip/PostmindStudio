'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Palette, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import type { BrandKit } from '@/lib/client/types';
import { EmptyState, ErrorState, StateBadge } from '../primitives';
import { ConfirmDialog } from '../publications/confirm-dialog';
import { BrandKitDialog, type BrandKitPayload } from './brand-kit-form';
import { VoiceKitSelect } from './voice-kit-select';
import { BrandKitMedia } from './brand-kit-media';

// Spec 8.5 — brand kits for the selected business: list, create, edit, delete, set default.

type Editing = { mode: 'create' } | { mode: 'edit'; kit: BrandKit } | null;

async function mutateKit(
  run: () => Promise<unknown>,
  success: string,
  refresh: () => void,
): Promise<boolean> {
  try {
    await run();
    toast.success(success);
    refresh();
    return true;
  } catch (err) {
    toast.error(errorMessage(err));
    return false;
  }
}

function KitCard({
  kit,
  onEdit,
  onDelete,
  onSetDefault,
  onVoiceSaved,
}: {
  kit: BrandKit;
  onEdit: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
  onVoiceSaved: () => void;
}) {
  const t = useTranslations('business.kits');
  return (
    <li className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-display text-2xl leading-tight">{kit.name}</h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {[kit.fontPrimary, kit.fontSecondary]
              .filter(Boolean)
              .map((f) => (f?.startsWith('upload:') ? t('uploadedFont') : f))
              .join(' / ') || t('defaultFonts')}
          </p>
        </div>
        {kit.isDefault && <StateBadge label={t('default')} tone="good" />}
      </div>
      <div className="flex h-8 overflow-hidden rounded-md ring-1 ring-foreground/10">
        {kit.colourPalette.length > 0 ? (
          kit.colourPalette.map((c) => (
            <span key={c} title={c} className="flex-1" style={{ backgroundColor: c }} />
          ))
        ) : (
          <span className="flex flex-1 items-center px-2 text-xs text-muted-foreground">
            {t('noColours')}
          </span>
        )}
      </div>
      {kit.toneKeywords.length > 0 && (
        <p className="text-sm text-muted-foreground">{kit.toneKeywords.join(' · ')}</p>
      )}
      <VoiceKitSelect kit={kit} onSaved={onVoiceSaved} />
      <BrandKitMedia kit={kit} onSaved={onVoiceSaved} />
      <div className="mt-auto flex flex-wrap gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={onEdit}
          aria-label={t('editAria', { name: kit.name })}
        >
          <Pencil /> {t('edit')}
        </Button>
        {!kit.isDefault && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSetDefault}
            aria-label={t('makeDefaultAria', { name: kit.name })}
          >
            <Star /> {t('makeDefault')}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          aria-label={t('deleteAria', { name: kit.name })}
        >
          <Trash2 /> {t('delete')}
        </Button>
      </div>
    </li>
  );
}

export function BrandKitsPanel({ businessId }: { businessId: string }) {
  const t = useTranslations('business.kits');
  const { data, error, isLoading, mutate } = useApi<{ data: BrandKit[] }>('/brand-kits', {
    businessId,
  });
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<BrandKit | null>(null);
  const refresh = () => void mutate();

  const create = (payload: BrandKitPayload) =>
    mutateKit(
      () =>
        api('/brand-kits', {
          method: 'POST',
          body: { ...payload, businessId },
          idempotencyKey: newIdempotencyKey(),
        }),
      t('created', { name: payload.name }),
      refresh,
    );
  const update = (kit: BrandKit, payload: BrandKitPayload) =>
    mutateKit(
      () =>
        api(`/brand-kits/${kit.id}`, {
          method: 'PATCH',
          body: payload,
          idempotencyKey: newIdempotencyKey(),
        }),
      t('saved', { name: payload.name }),
      refresh,
    );
  const setDefault = (kit: BrandKit) =>
    void mutateKit(
      () =>
        api(`/brand-kits/${kit.id}/set-default`, {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
        }),
      t('nowDefault', { name: kit.name }),
      refresh,
    );
  const remove = (kit: BrandKit) =>
    mutateKit(
      () => api(`/brand-kits/${kit.id}`, { method: 'DELETE', idempotencyKey: newIdempotencyKey() }),
      t('deleted', { name: kit.name }),
      refresh,
    );

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">{t('intro')}</p>
        <Button onClick={() => setEditing({ mode: 'create' })}>
          <Plus /> {t('new')}
        </Button>
      </div>
      {error && <ErrorState error={error} onRetry={refresh} />}
      {isLoading && <Skeleton aria-label={t('loading')} className="h-48 rounded-xl" />}
      {data && data.data.length === 0 && (
        <EmptyState
          icon={<Palette className="size-8" strokeWidth={1.5} />}
          title={t('empty.title')}
          description={t('empty.body')}
        />
      )}
      {data && data.data.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label={t('listAria')}>
          {data.data.map((kit) => (
            <KitCard
              key={kit.id}
              kit={kit}
              onEdit={() => setEditing({ mode: 'edit', kit })}
              onDelete={() => setDeleting(kit)}
              onSetDefault={() => setDefault(kit)}
              onVoiceSaved={refresh}
            />
          ))}
        </ul>
      )}
      {editing && (
        <BrandKitDialog
          key={editing.mode === 'edit' ? editing.kit.id : 'new'}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          kit={editing.mode === 'edit' ? editing.kit : undefined}
          onSubmit={(payload) =>
            editing.mode === 'edit' ? update(editing.kit, payload) : create(payload)
          }
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={
          deleting
            ? t('deleteConfirm.title', { name: deleting.name })
            : t('deleteConfirm.titleFallback')
        }
        description={t('deleteConfirm.body')}
        confirmLabel={t('deleteConfirm.confirm')}
        onConfirm={() => (deleting ? remove(deleting) : Promise.resolve(true))}
      />
    </div>
  );
}
