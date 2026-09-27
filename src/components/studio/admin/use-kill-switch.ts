'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import type { KillSwitchState, SetKillSwitchBody } from './types';

// GET/PUT /admin/kill-switch. PUT returns { flag }; the state is refetched afterwards so the
// lists reflect the change (this process's cache is invalidated immediately; workers within
// propagationSec).

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

export function useKillSwitch() {
  const state = useApi<KillSwitchState>('/admin/kill-switch');
  const { mutate } = state;
  const set = useCallback(
    async (body: SetKillSwitchBody): Promise<boolean> => {
      try {
        await api('/admin/kill-switch', {
          method: 'PUT',
          body,
          idempotencyKey: newIdempotencyKey(),
        });
        toast.success(describeChange(body));
        await mutate();
        return true;
      } catch (err) {
        toast.error(errorMessage(err));
        return false;
      }
    },
    [mutate],
  );
  return { data: state.data, error: state.error, isLoading: state.isLoading, mutate, set };
}
