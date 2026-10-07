'use client';

import { useId, useState, type ReactNode } from 'react';
import { Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Banner, BillingBanner, NoticeStripProvider } from '../account/account-banners';
import { useMe, type AccountBanner } from '../account/use-me';
import { UsageNotice, useUsage, type UsageResponse } from '../usage-meter';

// BACKLOG 25.4 — one calm strip under the top bar instead of banners stacked above every page.
// It shows the most urgent notice; the others wait behind an "n more" disclosure. The order:
// staff impersonation, a read-only or ended account, an exceeded allowance, a failed payment, a
// nearly used allowance, no plan yet, a running trial. None of these banners could be dismissed
// before 25.4, so none can here: each describes a state that is still true.

export type NoticeKind =
  | 'impersonating'
  | 'read_only'
  | 'cancelled'
  | 'usage_exceeded'
  | 'past_due'
  | 'usage_warning'
  | 'no_plan'
  | 'trial';

const PRIORITY: readonly NoticeKind[] = [
  'impersonating',
  'read_only',
  'cancelled',
  'usage_exceeded',
  'past_due',
  'usage_warning',
  'no_plan',
  'trial',
];

/** The notices that apply, most urgent first (pure: tested on its own). */
export function noticeKinds(input: {
  impersonating?: boolean;
  banner?: AccountBanner | null;
  usageStatus?: 'ok' | 'warning' | 'exceeded';
}): NoticeKind[] {
  const kinds = new Set<NoticeKind>();
  if (input.impersonating) kinds.add('impersonating');
  if (input.banner) kinds.add(input.banner.kind);
  if (input.usageStatus === 'exceeded') kinds.add('usage_exceeded');
  if (input.usageStatus === 'warning') kinds.add('usage_warning');
  return PRIORITY.filter((k) => kinds.has(k));
}

function ImpersonationNotice({ name }: { name: string }) {
  const t = useTranslations('shell.banners');
  return (
    <Banner tone="bad" icon={<Eye className="size-4" />}>
      <strong className="font-semibold">{t('impersonating.title')}</strong>{' '}
      {t('impersonating.body', { name })}
    </Banner>
  );
}

function renderNotice(
  kind: NoticeKind,
  ctx: {
    name: string;
    banner: AccountBanner | null;
    usage: UsageResponse['usage'] | undefined;
    now: number;
  },
): ReactNode {
  if (kind === 'impersonating') return <ImpersonationNotice name={ctx.name} />;
  if (kind === 'usage_exceeded' || kind === 'usage_warning')
    return ctx.usage ? <UsageNotice usage={ctx.usage} /> : null;
  return ctx.banner ? <BillingBanner banner={ctx.banner} now={ctx.now} /> : null;
}

export function NoticeStrip({ now = Date.now() }: { now?: number }) {
  const t = useTranslations('shell.notices');
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const me = useMe().data?.me;
  const usage = useUsage();
  const kinds = noticeKinds({
    impersonating: me?.impersonating,
    banner: me?.banner,
    usageStatus: usage?.status,
  });
  if (kinds.length === 0) return null;
  const ctx = {
    name: me ? (me.user.name ?? me.user.email ?? me.user.id) : '',
    banner: me?.banner ?? null,
    usage,
    now,
  };
  const [first, ...rest] = kinds;
  return (
    <NoticeStripProvider>
      <section
        aria-label={t('ariaLabel')}
        className="border-b border-border bg-surface-raised/60 px-4 md:px-8"
      >
        <div className="mx-auto flex w-full max-w-7xl items-start gap-3">
          <div className="min-w-0 flex-1">{first && renderNotice(first, ctx)}</div>
          {rest.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              className="mt-2.5 shrink-0"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? t('fewer') : t('more', { count: rest.length })}
            </Button>
          )}
        </div>
        {/* Collapsed notices stay in the document (hidden): a disabled Create button points at
            the billing banner's id with aria-describedby. */}
        <ul
          id={listId}
          hidden={!expanded}
          className={cn('mx-auto w-full max-w-7xl', expanded && 'border-t border-border')}
        >
          {rest.map((kind) => (
            <li key={kind}>{renderNotice(kind, ctx)}</li>
          ))}
        </ul>
      </section>
    </NoticeStripProvider>
  );
}
