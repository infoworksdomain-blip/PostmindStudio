'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import type { KillSwitchState, SetKillSwitchBody } from './types';

// GET/PUT /admin/kill-switch. PUT returns { flag }; the state is refetched afterwards so the
// lists reflect the change (this process's cache is invalidated immediately; workers within
// propagationSec). 15.D6: engaging the global level answers 202 { pending } — a second staff
// member confirms it (POST /admin/kill-switch/global/confirm) or anyone withdraws it
// (DELETE /admin/kill-switch/global/pending).

const LEVEL_NOUN: Record<SetKillSwitchBody['level'], string> = {
  global: 'Global kill switch',
  workspace: 'Workspace freeze',
  project: 'Project kill',
  provider: 'Provider disable',
  platform: 'Platform publishing halt',
};

export function describeChange(body: SetKillSwitchBody): string {
  const target = body.target ? ` (${body.target})` : '';
  return `${LEVEL_NOUN[body.level]}${target} ${body.enabled ? 'engaged' : 'released'}`;
}

export const PENDING_TOAST =
  'Global kill requested. A second PostMind staff member must confirm it within 10 minutes.';

export function useKillSwitch() {
  const state = useApi<KillSwitchState>('/admin/kill-switch');
  const { mutate } = state;
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
    [mutate],
  );
  const set = useCallback(
    (body: SetKillSwitchBody) =>
      run(async () => {
        const res = await api<{ pending?: unknown }>('/admin/kill-switch', {
          method: 'PUT',
          body,
          idempotencyKey: newIdempotencyKey(),
        });
        return res?.pending ? PENDING_TOAST : describeChange(body);
      }),
    [run],
  );
  const confirmGlobal = useCallback(
    (requestId: string, reason: string) =>
      run(async () => {
        await api('/admin/kill-switch/global/confirm', {
          method: 'POST',
          body: { requestId, reason },
          idempotencyKey: newIdempotencyKey(),
        });
        return 'Global kill switch engaged (two-person approval)';
      }),
    [run],
  );
  const withdrawGlobal = useCallback(
    () =>
      run(async () => {
        await api('/admin/kill-switch/global/pending', { method: 'DELETE' });
        return 'Global kill request withdrawn';
      }),
    [run],
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
