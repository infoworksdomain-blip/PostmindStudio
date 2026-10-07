'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Check, RefreshCw, Shuffle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { NativeSelect } from '@/components/ui/native-select';
import { api, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import type { CategoryOption } from '../library/library-utils';
import type { BulkAction, BulkResponse, ReanalyseResponse } from './library-admin-types';

// 15.D7 / A3.8 — bulk actions on the selected corpus items: accept the automatic category,
// override it, reject (retires the item), or re-run analysis + embedding on the stored source.

const DONE = {
  accept: 'doneAccept',
  override: 'doneOverride',
  reject: 'doneReject',
} as const satisfies Record<BulkAction, string>;

export function LibraryBulkBar({
  ids,
  categories,
  onDone,
}: {
  ids: string[];
  categories: CategoryOption[];
  onDone: () => void;
}) {
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const t = useTranslations('admin.library.bulk');
  const errorMessage = useErrorMessage();
  const n = ids.length;

  const bulk = async (action: BulkAction): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await api<BulkResponse>('/admin/library/videos/bulk', {
        method: 'POST',
        body: { ids, action, ...(action === 'override' && { category }) },
        idempotencyKey: newIdempotencyKey(),
      });
      const done = t(DONE[action], { count: res.updated.length });
      toast.success(
        res.missing.length
          ? [done, t('notFound', { count: res.missing.length })].join(' · ')
          : done,
      );
      onDone();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reanalyse = async () => {
    setBusy(true);
    try {
      const res = await api<ReanalyseResponse>('/admin/library/reanalyse', {
        method: 'POST',
        body: { ids },
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('reanalyseQueued', { count: res.queued.length }));
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="toolbar"
      aria-label={t('toolbarAria')}
      className="flex flex-wrap items-end gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3"
    >
      <p className="me-auto self-center text-sm font-medium" aria-live="polite">
        {t('selected', { count: n })}
      </p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk('accept')}>
        <Check /> {t('accept')}
      </Button>
      <div className="flex items-end gap-2">
        <div className="w-48">
          <label htmlFor="bulk-category" className="sr-only">
            {t('newCategory')}
          </label>
          <NativeSelect
            id="bulk-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">{t('newCategoryPlaceholder')}</option>
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>
                {`${'  '.repeat(c.depth)}${c.label}`}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !category}
          onClick={() => void bulk('override')}
        >
          <Shuffle /> {t('override')}
        </Button>
      </div>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void reanalyse()}>
        <RefreshCw /> {t('reanalyse')}
      </Button>
      <Button size="sm" variant="destructive" disabled={busy} onClick={() => setRejecting(true)}>
        <X /> {t('reject')}
      </Button>
      <ConfirmDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title={t('rejectTitle', { count: n })}
        description={t('rejectBody')}
        confirmLabel={t('rejectConfirm')}
        onConfirm={() => bulk('reject')}
      />
    </div>
  );
}
