'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/client/api';

// BACKLOG 13.15 — "Resubmit failures": POST /admin/library/ingest/resubmit { failedOnly: true }
// re-enqueues every FAILED corpus run with the item it was submitted with (staff only).

export interface ResubmitResponse {
  queued: number;
  skipped: number;
  runs: Array<{ runId: string; action: 'queued' | 'skipped'; reason?: string }>;
}

export function ResubmitFailures({ failed, onDone }: { failed: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={failed === 0 || busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await api<ResubmitResponse>('/admin/library/ingest/resubmit', {
            method: 'POST',
            body: { failedOnly: true },
          });
          const legacy = res.runs.filter((r) => r.reason?.startsWith('no stored item')).length;
          toast.success(
            `Resubmitted ${res.queued} failed source${res.queued === 1 ? '' : 's'}` +
              (res.skipped ? ` · ${res.skipped} skipped` : '') +
              (legacy
                ? ` (${legacy} submitted before resubmission existed: use the ingest tool)`
                : ''),
          );
          onDone();
        } catch (err) {
          toast.error(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <RotateCcw /> Resubmit failures
    </Button>
  );
}
