'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import type { KillSwitchState, SetKillSwitchBody } from './types';

// GET/PUT /admin/kill-switch. PUT returns { flag }; the state is refetched afterwards so the
// lists reflect the change (this process's cache is invalidated immediately; workers within
// propagationSec). 15.D6: engaging the global level answers 202 { pending } — a second staff
// member confirms it (POST /admin/kill-switch/global/confirm) or anyone withdraws it
// (DELETE /admin/kill-switch/global/pending).

export function useKillSwitch() {
  const state = useApi<KillSwitchState>('/admin/kill-switch');
  const { mutate } = state;
  const t = useTranslations('admin.killSwitch.toast');
  const errorMessage = useErrorMessage();
  const describeChange = useCallback(
    (body: SetKillSwitchBody): string => {
      if (body.level === 'global') return body.enabled ? t('globalEngaged') : t('globalReleased');
      const target = body.target ?? '';
      return body.enabled
        ? t(`engaged.${body.level}`, { target })
        : t(`released.${body.level}`, { target });
    },
    [t],
  );
  const run = useCallback(
    async (work: () => Promise<string>): Promise<boolean> => {
      try {
        toast.success(await work());
        await mutate();
        return true;
      } catch (err) {
        toast.error(errorMessage(err));
        return false;
      }
    },
    [mutate, errorMessage],
  );
  const set = useCallback(
    (body: SetKillSwitchBody) =>
      run(async () => {
        const res = await api<{ pending?: unknown }>('/admin/kill-switch', {
          method: 'PUT',
          body,
          idempotencyKey: newIdempotencyKey(),
        });
        return res?.pending ? t('pending') : describeChange(body);
      }),
    [run, t, describeChange],
  );
  const confirmGlobal = useCallback(
    (requestId: string, reason: string) =>
      run(async () => {
        await api('/admin/kill-switch/global/confirm', {
          method: 'POST',
          body: { requestId, reason },
          idempotencyKey: newIdempotencyKey(),
        });
        return t('confirmed');
      }),
    [run, t],
  );
  const withdrawGlobal = useCallback(
    () =>
      run(async () => {
        await api('/admin/kill-switch/global/pending', { method: 'DELETE' });
        return t('withdrawn');
      }),
    [run, t],
  );
  return {
    data: state.data,
    error: state.error,
    isLoading: state.isLoading,
    mutate,
    set,
    confirmGlobal,
    withdrawGlobal,
  };
}
