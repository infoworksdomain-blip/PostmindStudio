'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage, newIdempotencyKey, type ApiRequest } from '@/lib/client/api';

// Shared by Review, Slideshow and Overlay screens: run one write, send an Idempotency-Key, toast
// the outcome and expose which action is in flight (so its button can show progress and every
// other write can be disabled while it runs).

export interface ActionOptions {
  method?: ApiRequest['method'];
  body?: unknown;
  /** Toast on success; omit for silent writes. */
  success?: string;
}

export function useAction() {
  const [pending, setPending] = useState<string | null>(null);

  const run = useCallback(
    async <T>(key: string, path: string, options: ActionOptions = {}): Promise<T | null> => {
      setPending(key);
      try {
        const result = await api<T>(path, {
          method: options.method ?? 'POST',
          body: options.body,
          idempotencyKey: newIdempotencyKey(),
        });
        if (options.success) toast.success(options.success);
        return result;
      } catch (err) {
        toast.error(errorMessage(err));
        return null;
      } finally {
        setPending(null);
      }
    },
    [],
  );

  return { pending, run, busy: pending !== null };
}
