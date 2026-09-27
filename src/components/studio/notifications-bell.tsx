'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api, errorMessage, useApi } from '@/lib/client/api';
import { relativeTime } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { NotificationPreferencesButton } from './notification-preferences';

// Spec 14.4 — in-app notifications (GET /notifications): generation complete, approval
// pending > 2 h, publication failed, cost 80% / 100% / paused. Polls every minute.

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
              {n.title}
            </Link>
          ) : (
            <p className="font-medium">{n.title}</p>
          )}
          <p className="text-xs text-muted-foreground">{n.body}</p>
          {n.emailStatus === 'pending_setup' && (
            <p className="text-[0.7rem] text-muted-foreground italic">
              Email pending setup: email delivery is not connected yet.
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <time dateTime={n.createdAt} className="text-[0.7rem] text-muted-foreground">
              {relativeTime(n.createdAt)}
            </time>
            {unread && (
              <button
                type="button"
                className="text-[0.7rem] text-primary hover:underline"
                onClick={() => void onRead(n.id)}
                aria-label={`Mark “${n.title}” as read`}
              >
                Mark read
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export function NotificationsBell() {
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
          aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          <Bell />
          {unread > 0 && (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[0.6rem] font-semibold text-primary-foreground"
            >
              {unreadLabel(unread)}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
          <h2 className="text-sm font-semibold">Notifications</h2>
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={unread === 0}
              onClick={() => void markAll()}
            >
              <CheckCheck /> Mark all read
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
          {!error && !data && <p className="px-2 py-4 text-sm text-muted-foreground">Loading…</p>}
          {data && data.data.length === 0 && (
            <p className="px-2 py-4 text-sm text-muted-foreground">No notifications yet.</p>
          )}
          {data && data.data.length > 0 && (
            <ul aria-label="Notifications" className="grid gap-0.5">
              {data.data.map((n) => (
                <Item key={n.id} n={n} onRead={markRead} />
              ))}
            </ul>
          )}
        </div>
        <p className="border-t border-border/70 px-3 py-2 text-[0.7rem] text-muted-foreground">
          In-app only. Email delivery isn’t available yet.
        </p>
      </PopoverContent>
    </Popover>
  );
}
