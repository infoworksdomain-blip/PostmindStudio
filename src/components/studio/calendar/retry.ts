'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { api, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import type { Publication } from '@/lib/client/types';

// A failed publication can be retried from the calendar: POST /publications/:id/retry (the same
// call as the Publications list's Retry button).

export function canRetry(publication: Publication): boolean {
  return publication.state === 'FAILED';
}

export function useRetryPublication(onDone: () => void) {
  const t = useTranslations('publications.actions');
  const errorMessage = useErrorMessage();
  const [retrying, setRetrying] = useState<string | null>(null);
  const retry = async (publication: Publication): Promise<void> => {
    setRetrying(publication.id);
    try {
      await api(`/publications/${publication.id}/retry`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('done.retry'));
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRetrying(null);
    }
  };
  return { retry, retrying };
}
