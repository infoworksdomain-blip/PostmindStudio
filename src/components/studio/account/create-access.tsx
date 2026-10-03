'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMe } from './use-me';

// A read-only organisation (payment overdue, subscription ended) or one with no plan yet cannot
// create or generate: the server answers 402 (src/lib/studio/billing/access-gate.ts). This
// mirrors that on the screen, so the create buttons are disabled with a visible reason and a link
// to billing instead of a click that appears to do nothing. The server stays the authority.

export type CreateBlock = 'read_only' | 'none';

/** Why this organisation cannot create right now, or null (still loading counts as allowed). */
export function useCreateBlock(): CreateBlock | null {
  const { data } = useMe();
  const access = data?.me?.plan?.access;
  return access === 'read_only' || access === 'none' ? access : null;
}

/** Id of the notice below, for aria-describedby on the disabled button. */
export const CREATE_BLOCK_NOTICE_ID = 'create-blocked-notice';

export function CreateBlockedNotice({
  block,
  className,
}: {
  block: CreateBlock | null;
  className?: string;
}) {
  const t = useTranslations('shell.banners.createBlocked');
  if (!block) return null;
  const readOnly = block === 'read_only';
  return (
    <p
      id={CREATE_BLOCK_NOTICE_ID}
      role="status"
      className={className ?? 'text-sm text-destructive'}
    >
      {readOnly ? t('readOnly') : t('noPlan')}{' '}
      <Link href="/settings/billing" className="font-medium underline underline-offset-4">
        {readOnly ? t('readOnlyAction') : t('noPlanAction')}
      </Link>
    </p>
  );
}
