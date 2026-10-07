'use client';

import Link from 'next/link';
import { AlertTriangle, Archive, Clock, CreditCard, Eye, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { useMe, type AccountBanner } from './use-me';

// Phase 18 §3 / §P.3 — account-state banners at the top of every app page: a superadmin
// impersonating (always first), then the most urgent billing state from /me: read-only (payment
// overdue), subscription ended (Phase 19.5: read-only, with the deletion date when known), past
// due (with the grace deadline), no plan yet, or a running trial (days left). Each links to
// billing (Track C's /settings/billing).

const DAY_MS = 86_400_000;

type Tone = 'info' | 'warn' | 'bad';

const TONE: Record<Tone, string> = {
  info: 'border-data/25 bg-data-soft text-foreground',
  warn: 'border-warning/40 bg-warning/15 text-foreground',
  bad: 'border-destructive/30 bg-destructive/8 text-foreground',
};

/** Id of the billing banner, so a disabled create button can point at it (aria-describedby). */
export const ACCOUNT_BANNER_ID = 'account-banner';

function Banner({
  tone,
  id,
  icon,
  children,
  action,
}: {
  tone: Tone;
  id?: string;
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      id={id}
      role={tone === 'info' ? 'status' : 'alert'}
      className={cn(
        'mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3 text-sm',
        TONE[tone],
      )}
    >
      <span aria-hidden className="shrink-0">
        {icon}
      </span>
      <p className="min-w-0 flex-1">{children}</p>
      {action}
    </div>
  );
}

function BillingLink({ children }: { children: ReactNode }) {
  return (
    <Link
      href="/settings/billing"
      className="font-medium whitespace-nowrap underline underline-offset-4 hover:no-underline"
    >
      {children}
    </Link>
  );
}

export function BillingBanner({ banner, now }: { banner: AccountBanner; now: number }) {
  const t = useTranslations('shell.banners');
  const f = useFormat();
  switch (banner.kind) {
    case 'read_only':
      return (
        <Banner
          id={ACCOUNT_BANNER_ID}
          tone="bad"
          icon={<Lock className="size-4" />}
          action={<BillingLink>{t('readOnly.action')}</BillingLink>}
        >
          <strong className="font-semibold">{t('readOnly.title')}</strong> {t('readOnly.body')}
        </Banner>
      );
    case 'cancelled':
      return (
        <Banner
          id={ACCOUNT_BANNER_ID}
          tone="bad"
          icon={<Archive className="size-4" />}
          action={<BillingLink>{t('cancelled.action')}</BillingLink>}
        >
          <strong className="font-semibold">{t('cancelled.title')}</strong> {t('cancelled.body')}
          {banner.deletesAt && (
            <>
              {' '}
              {t('cancelled.deletesOn', {
                date: f.date(banner.deletesAt, { day: 'numeric', month: 'long', year: 'numeric' }),
              })}
            </>
          )}
        </Banner>
      );
    case 'past_due':
      return (
        <Banner
          id={ACCOUNT_BANNER_ID}
          tone="warn"
          icon={<AlertTriangle className="size-4" />}
          action={<BillingLink>{t('pastDue.action')}</BillingLink>}
        >
          <strong className="font-semibold">{t('pastDue.title')}</strong>{' '}
          {banner.graceUntil
            ? t('pastDue.bodyUntil', {
                date: f.date(banner.graceUntil, { day: 'numeric', month: 'long' }),
              })
            : t('pastDue.body')}
        </Banner>
      );
    case 'no_plan':
      return (
        <Banner
          id={ACCOUNT_BANNER_ID}
          tone="info"
          icon={<CreditCard className="size-4" />}
          action={<BillingLink>{t('noPlan.action')}</BillingLink>}
        >
          <strong className="font-semibold">{t('noPlan.title')}</strong> {t('noPlan.body')}
        </Banner>
      );
    case 'trial': {
      const days = Math.max(0, Math.ceil((Date.parse(banner.endsAt) - now) / DAY_MS));
      return (
        <Banner
          id={ACCOUNT_BANNER_ID}
          tone="info"
          icon={<Clock className="size-4" />}
          action={<BillingLink>{t('trial.action')}</BillingLink>}
        >
          {t('trial.body', { days })}
        </Banner>
      );
    }
  }
}

export function AccountBanners({ now = Date.now() }: { now?: number }) {
  const t = useTranslations('shell.banners');
  const { data } = useMe();
  if (!data) return null;
  const { me } = data;
  return (
    <>
      {me.impersonating && (
        <Banner tone="bad" icon={<Eye className="size-4" />}>
          <strong className="font-semibold">{t('impersonating.title')}</strong>{' '}
          {t('impersonating.body', { name: me.user.name ?? me.user.email ?? me.user.id })}
        </Banner>
      )}
      {me.banner && <BillingBanner banner={me.banner} now={now} />}
    </>
  );
}
