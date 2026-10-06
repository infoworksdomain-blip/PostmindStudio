'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, newIdempotencyKey, useApi } from '@/lib/client/api';
import { EmptyState, ErrorState } from '../primitives';
import { ConfirmDialog } from '../publications/confirm-dialog';
import {
  creatorPath,
  creatorsPath,
  MAX_CREATORS,
  useCreatorErrorMessage,
  type Creator,
} from '../creators/types';
import { CreatorCard } from './creator-card';
import { CreatorDialog } from './creator-dialog';
import { CreatorEditDialog, type EditKind } from './creator-edit-dialog';

// BACKLOG 22.3 — Business → Creators: the business's reusable AI creators as a grid of portraits.
// Create (generated or a consented photo), regenerate the portrait with changes, rename, make
// the month-plan default, retire. Create → UGC picks one of these so every video has the same
// face. At most MAX_CREATORS per business; never a cost.

export function CreatorsPanel({ businessId }: { businessId: string }) {
  const t = useTranslations('business.creators');
  const creatorError = useCreatorErrorMessage();
  const { data, error, isLoading, mutate } = useApi<{ data: Creator[] }>(creatorsPath(businessId));
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<{ kind: EditKind; creator: Creator } | null>(null);
  const [retiring, setRetiring] = useState<Creator | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const refresh = () => void mutate();
  const creators = data?.data ?? [];
  const full = creators.length >= MAX_CREATORS;

  async function makeDefault(creator: Creator) {
    setBusyId(creator.id);
    try {
      await api(creatorPath(businessId, creator.id), {
        method: 'PATCH',
        body: { isDefault: true },
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('defaultSet', { name: creator.name }));
      refresh();
    } catch (err) {
      toast.error(creatorError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function retire(creator: Creator): Promise<boolean> {
    try {
      await api(`${creatorPath(businessId, creator.id)}/retire`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('retired', { name: creator.name }));
      refresh();
      return true;
    } catch (err) {
      toast.error(creatorError(err));
      return false;
    }
  }

  return (
    <section className="grid gap-5" aria-labelledby="creators-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-xl">
          <h2 id="creators-heading" className="font-display text-3xl leading-none">
            {t('title')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('intro', { max: MAX_CREATORS })}</p>
        </div>
        <div className="flex items-center gap-3">
          {data && (
            <span
              className="text-xs text-muted-foreground tabular-nums"
              data-testid="creator-count"
            >
              {t('count', { count: creators.length, max: MAX_CREATORS })}
            </span>
          )}
          <Button
            onClick={() => setCreating(true)}
            disabled={full}
            title={full ? t('full') : undefined}
          >
            <Plus /> {t('create')}
          </Button>
        </div>
      </div>
      {error && <ErrorState error={error} onRetry={refresh} />}
      {isLoading && <Skeleton aria-label={t('loading')} className="h-72 rounded-2xl" />}
      {data && creators.length === 0 && (
        <EmptyState
          illustration="business"
          title={t('empty.title')}
          description={t('empty.body')}
        />
      )}
      {creators.length > 0 && (
        <ul
          className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4"
          aria-label={t('listAria')}
        >
          {creators.map((c) => (
            <CreatorCard
              key={c.id}
              creator={c}
              busy={busyId === c.id}
              actions={{
                onRegenerate: () => setEditing({ kind: 'regenerate', creator: c }),
                onRename: () => setEditing({ kind: 'rename', creator: c }),
                onMakeDefault: () => void makeDefault(c),
                onRetire: () => setRetiring(c),
              }}
            />
          ))}
        </ul>
      )}
      {creating && (
        <CreatorDialog
          open
          onOpenChange={setCreating}
          businessId={businessId}
          onCreated={(c) => {
            if (c.status === 'READY') toast.success(t('created', { name: c.name }));
            else toast.warning(t('createdDraft', { name: c.name }));
            refresh();
          }}
        />
      )}
      {editing && (
        <CreatorEditDialog
          kind={editing.kind}
          creator={editing.creator}
          businessId={businessId}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={(c) => {
            if (editing.kind === 'rename') toast.success(t('renamed', { name: c.name }));
            else if (c.portraitError) toast.warning(t('portraitError'));
            else toast.success(t('regenerated', { name: c.name }));
            refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={retiring !== null}
        onOpenChange={(open) => !open && setRetiring(null)}
        title={t('retireConfirm.title', { name: retiring?.name ?? '' })}
        description={t('retireConfirm.body')}
        confirmLabel={t('retireConfirm.confirm')}
        onConfirm={() => (retiring ? retire(retiring) : Promise.resolve(true))}
      />
    </section>
  );
}
