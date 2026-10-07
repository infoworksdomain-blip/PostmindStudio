'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { NotificationPreferencesButton } from './notification-preferences';
import { useNotificationText } from './notification-text';

// Spec 14.4 — in-app notifications (GET /notifications): generation complete, approval
// pending > 2 h, publication failed, cost 80% / 100% / paused. Polls every minute.
// BACKLOG 16.5: a notification stored with a message key renders in the reader's locale
// (notification-text.ts); older rows without one show their stored English text.

export interface StudioNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
  /** 13.33: null = no email requested; pending_setup until an email sender exists. */
  emailStatus?: 'pending_setup' | 'sent' | 'failed' | null;
  /** 16.5: key under the `notifications` catalogue namespace + its ICU parameters. */
  messageKey?: string | null;
  messageParams?: Record<string, string | number> | null;
}

export interface NotificationsResponse {
  ok: true;
  data: StudioNotification[];
  unreadCount: number;
  nextCursor: string | null;
}

const POLL_MS = 60_000;
const COST_KINDS = new Set(['cost_alert', 'cost_paused', 'publication_failed']);

/** Only app-relative links are followed (the server only writes /paths). */
function safeLink(link: string | null): string | null {
  return link && link.startsWith('/') && !link.startsWith('//') ? link : null;
}

export function unreadLabel(count: number): string {
  return count > 9 ? '9+' : String(count);
}

function Item({ n, onRead }: { n: StudioNotification; onRead: (id: string) => Promise<void> }) {
  const t = useTranslations('shell.notifications');
  const f = useFormat();
  const { title, body } = useNotificationText()(n);
  const unread = !n.readAt;
  const href = safeLink(n.link);
  return (
    <li className={cn('grid gap-1 rounded-md px-2 py-2', unread && 'bg-accent/50')}>
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={cn(
            'mt-1.5 size-2 shrink-0 rounded-full',
            unread ? (COST_KINDS.has(n.kind) ? 'bg-destructive' : 'bg-primary') : 'bg-transparent',
          )}
        />
        <div className="grid min-w-0 flex-1 gap-0.5">
          {href ? (
            <Link
              href={href}
              className="font-medium hover:underline"
              onClick={() => void (unread ? onRead(n.id) : undefined)}
            >
              {title}
            </Link>
          ) : (
            <p className="font-medium">{title}</p>
          )}
          <p className="text-xs text-muted-foreground">{body}</p>
          {n.emailStatus === 'pending_setup' && (
            <p className="text-[0.7rem] text-muted-foreground italic">{t('emailPendingSetup')}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            <time dateTime={n.createdAt} className="text-[0.7rem] text-muted-foreground">
              {f.relative(n.createdAt)}
            </time>
            {unread && (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="text-[0.7rem]"
                onClick={() => void onRead(n.id)}
                aria-label={t('markReadAria', { title })}
              >
                {t('markRead')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export function NotificationsBell() {
  const t = useTranslations('shell.notifications');
  const tc = useTranslations('common.states');
  const errorMessage = useErrorMessage();
  const [open, setOpen] = useState(false);
  const { data, error, mutate } = useApi<NotificationsResponse>(
    '/notifications',
    { limit: 20 },
    { refreshInterval: POLL_MS },
  );
  const unread = data?.unreadCount ?? 0;

  const markRead = async (id: string) => {
    try {
      await api(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} });
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const markAll = async () => {
    try {
      await api('/notifications/read-all', { method: 'POST', body: {} });
      await mutate();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={t('bellAria', { count: unread })}
        >
          <Bell />
          {unread > 0 && (
            <span
              aria-hidden
              className="absolute -top-0.5 -end-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[0.6rem] font-semibold text-primary-foreground"
            >
              {unreadLabel(unread)}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
          <h2 className="text-sm font-semibold">{t('title')}</h2>
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={unread === 0}
              onClick={() => void markAll()}
            >
              <CheckCheck /> {t('markAllRead')}
            </Button>
            {/* 13.24 per-kind in-app / email preferences */}
            <NotificationPreferencesButton />
          </div>
        </div>
        <div className="max-h-96 overflow-y-auto p-1">
          {error && (
            <p role="alert" className="px-2 py-4 text-sm text-destructive">
              {errorMessage(error)}
            </p>
          )}
          {!error && !data && (
            <p className="px-2 py-4 text-sm text-muted-foreground">{tc('loading')}</p>
          )}
          {data && data.data.length === 0 && (
            <p className="px-2 py-4 text-sm text-muted-foreground">{t('empty')}</p>
          )}
          {data && data.data.length > 0 && (
            <ul aria-label={t('title')} className="grid gap-0.5">
              {data.data.map((n) => (
                <Item key={n.id} n={n} onRead={markRead} />
              ))}
            </ul>
          )}
        </div>
        <p className="border-t border-border/70 px-3 py-2 text-[0.7rem] text-muted-foreground">
          {t('inAppOnly')}
        </p>
      </PopoverContent>
    </Popover>
  );
}
