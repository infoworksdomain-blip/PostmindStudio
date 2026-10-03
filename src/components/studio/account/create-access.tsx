'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMe } from './use-me';

// A read-only organisation (payment overdue, subscription ended) cannot create or generate: the
// server answers 402 billing_required (src/lib/studio/billing/access-gate.ts) to every mutation.
// This mirrors that on the screen: the create buttons are disabled, aria-describedby points at an
// inline reason with a link to billing, instead of a click that appears to do nothing. The server
// stays the authority. An organisation with no plan yet keeps its buttons: the click opens the
// "choose a plan" dialog (billing/upgrade-dialog.tsx) and a slideshow draft still works.

/** True when this organisation is read-only (still loading counts as not blocked). */
export function useCreateBlock(): 'read_only' | null {
  const { data } = useMe();
  return data?.me?.plan?.access === 'read_only' ? 'read_only' : null;
}

/** Id of the notice below, for aria-describedby on the disabled button. */
export const CREATE_BLOCK_NOTICE_ID = 'create-blocked-notice';

export function CreateBlockedNotice({
  block,
  className,
}: {
  block: 'read_only' | null;
  className?: string;
}) {
  const t = useTranslations('shell.banners.createBlocked');
  if (!block) return null;
  return (
    <p
      id={CREATE_BLOCK_NOTICE_ID}
      role="status"
      className={className ?? 'text-sm text-destructive'}
    >
      {t('readOnly')}{' '}
      <Link href="/settings/billing" className="font-medium underline underline-offset-4">
        {t('readOnlyAction')}
      </Link>
    </p>
  );
}
