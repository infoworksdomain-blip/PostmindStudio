'use client';

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { ApiError, useErrorMessage } from '@/lib/client/api';

// Phase 18 — member and organisation errors carry a `details.reason` the generic error code does
// not say (last owner, owner only, already a member, wrong confirmation name). Known reasons get
// their own sentence; everything else falls back to the shared error message.

const REASONS = [
  'last_owner',
  'owner_only',
  'already_member',
  'name_mismatch',
  // §5.11 re-authentication (auth/reauth.ts) before deletion and ownership transfer.
  'reauth_failed',
  'reauth_required',
] as const;
type Reason = (typeof REASONS)[number];

const KEY: Record<
  Reason,
  'lastOwner' | 'ownerOnly' | 'alreadyMember' | 'nameMismatch' | 'wrongPassword' | 'signInAgain'
> = {
  last_owner: 'lastOwner',
  owner_only: 'ownerOnly',
  already_member: 'alreadyMember',
  name_mismatch: 'nameMismatch',
  reauth_failed: 'wrongPassword',
  reauth_required: 'signInAgain',
};

export function reasonOf(err: unknown): Reason | null {
  if (!(err instanceof ApiError)) return null;
  const reason = err.details?.reason;
  return typeof reason === 'string' && (REASONS as readonly string[]).includes(reason)
    ? (reason as Reason)
    : null;
}

export function useSettingsError(): (err: unknown) => string {
  const t = useTranslations('members.errors');
  const fallback = useErrorMessage();
  return useCallback(
    (err: unknown) => {
      const reason = reasonOf(err);
      return reason ? t(KEY[reason]) : fallback(err);
    },
    [t, fallback],
  );
}
