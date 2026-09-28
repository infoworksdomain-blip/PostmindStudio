'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Check, RefreshCw, Shuffle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, errorMessage, newIdempotencyKey } from '@/lib/client/api';
import { selectClass } from '../library/library-filters';
import type { CategoryOption } from '../library/library-utils';
import { ConfirmDialog } from './confirm-dialog';
import type { BulkAction, BulkResponse, ReanalyseResponse } from './library-admin-types';

// 15.D7 / A3.8 — bulk actions on the selected corpus items: accept the automatic category,
// override it, reject (retires the item), or re-run analysis + embedding on the stored source.

const DONE: Record<BulkAction, string> = {
  accept: 'Category accepted',
  override: 'Category overridden',
  reject: 'Rejected and retired',
};

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
  const n = ids.length;
  const plural = n === 1 ? '' : 's';

  const bulk = async (action: BulkAction): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await api<BulkResponse>('/admin/library/videos/bulk', {
        method: 'POST',
        body: { ids, action, ...(action === 'override' && { category }) },
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(
        `${DONE[action]} for ${res.updated.length} item${res.updated.length === 1 ? '' : 's'}` +
          (res.missing.length ? ` · ${res.missing.length} not found` : ''),
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
      toast.success(
        `Re-analysis queued for ${res.queued.length} item${res.queued.length === 1 ? '' : 's'}`,
      );
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
      aria-label="Bulk actions"
      className="flex flex-wrap items-end gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3"
    >
      <p className="mr-auto self-center text-sm font-medium" aria-live="polite">
        {n} selected
      </p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk('accept')}>
        <Check /> Accept category
      </Button>
      <div className="flex items-end gap-2">
        <div className="w-48">
          <label htmlFor="bulk-category" className="sr-only">
            New category
          </label>
          <select
            id="bulk-category"
            className={selectClass}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">New category…</option>
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>
                {`${'  '.repeat(c.depth)}${c.label}`}
              </option>
            ))}
          </select>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !category}
          onClick={() => void bulk('override')}
        >
          <Shuffle /> Override
        </Button>
      </div>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void reanalyse()}>
        <RefreshCw /> Re-analyse
      </Button>
      <Button size="sm" variant="destructive" disabled={busy} onClick={() => setRejecting(true)}>
        <X /> Reject
      </Button>
      <ConfirmDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title={`Reject ${n} item${plural}?`}
        description="Rejected items are retired: hidden from browse, search and recommendations. Projects that already used them keep working."
        confirmLabel="Reject and retire"
        onConfirm={() => bulk('reject')}
      />
    </div>
  );
}
