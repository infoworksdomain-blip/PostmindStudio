'use client';

import { useState, type FormEvent } from 'react';
import { ArrowLeft, Eye, KeyRound, LogOut, Search, ShieldCheck, ShieldOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { hardNavigate } from '@/lib/client/navigate';
import { EmptyState, ErrorState, Section } from '../../primitives';
import { StatusBadge } from '../organisations/status-badge';
import { ReasonDialog } from '../reason-dialog';

// Phase 18 §3 admin → Users: search by email, name or id; verified, 2FA, platform role, sessions;
// ban / unban, sign out everywhere and reset 2FA (each needs a reason and is audited); and, only
// when STUDIO_IMPERSONATION_ENABLED is on, "View as this user" (superadmin, read-only session).

export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  role: string;
  banned: boolean;
  banReason: string | null;
  createdAt: string;
  deletedAt: string | null;
  sessions: number;
  organisations: number;
}

export interface AdminUsersResponse {
  ok: true;
  total: number;
  data: AdminUserRow[];
}

export interface AdminUserDetail {
  ok: true;
  user: AdminUserRow;
  memberships: Array<{ organisationId: string; organisationName: string; role: string }>;
  impersonation: boolean;
}

type Action = 'ban' | 'unban' | 'sessions' | 'twoFactor' | 'impersonate';

function YesNo({ value, yes, no }: { value: boolean; yes: string; no: string }) {
  return (
    <StatusPill tone={value ? 'good' : 'neutral'} size="sm">
      {value ? yes : no}
    </StatusPill>
  );
}

function UserDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useTranslations('adminUsers.detail');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const { data, error, mutate } = useApi<AdminUserDetail>(`/admin/users/${encodeURIComponent(id)}`);
  const [action, setAction] = useState<Action | null>(null);
  const base = `/admin/users/${encodeURIComponent(id)}`;

  async function run(kind: Action, reason: string): Promise<boolean> {
    try {
      if (kind === 'ban' || kind === 'unban')
        await api(`${base}/ban`, { method: 'POST', body: { banned: kind === 'ban', reason } });
      else if (kind === 'sessions')
        await api(`${base}/sessions`, { method: 'DELETE', body: { reason } });
      else if (kind === 'twoFactor')
        await api(`${base}/two-factor`, { method: 'DELETE', body: { reason } });
      else {
        const res = await api<{ redirectTo: string }>(`${base}/impersonate`, {
          method: 'POST',
          body: { reason },
        });
        hardNavigate(res.redirectTo);
        return true;
      }
      toast.success(t(`done.${kind}`));
      await mutate();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  }

  return (
    <div className="grid gap-10">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="rtl:-scale-x-100" /> {t('back')}
        </Button>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : !data ? (
        <Skeleton className="h-64 rounded-xl" aria-label={t('loading')} />
      ) : (
        <>
          <Section
            variant="panel"
            title={data.user.name}
            description={data.user.email}
            actions={
              <span className="flex gap-1">
                {data.user.banned && <StatusBadge value="banned" />}
                {data.user.deletedAt && <StatusBadge value="deleted" />}
              </span>
            }
          >
            <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">{t('verified')}</dt>
                <dd>
                  <YesNo value={data.user.emailVerified} yes={t('yes')} no={t('no')} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('twoFactor')}</dt>
                <dd>
                  <YesNo value={data.user.twoFactorEnabled} yes={t('yes')} no={t('no')} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('role')}</dt>
                <dd>
                  {t(
                    `roles.${data.user.role === 'staff' || data.user.role === 'superadmin' ? data.user.role : 'user'}`,
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('sessions')}</dt>
                <dd className="tabular-nums">{f.number(data.user.sessions)}</dd>
              </div>
            </dl>
            {data.user.banReason && (
              <p className="mt-4 text-sm text-muted-foreground">
                {t('banReason', { reason: data.user.banReason })}
              </p>
            )}
          </Section>
          <Section title={t('membershipsTitle')}>
            {data.memberships.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noMemberships')}</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {data.memberships.map((m) => (
                  <li key={m.organisationId} className="flex justify-between gap-3 py-2">
                    <span>{m.organisationName}</span>
                    <span className="text-muted-foreground">{m.role}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={t('actionsTitle')} description={t('actionsHint')}>
            <div className="flex flex-wrap gap-2">
              {data.user.banned ? (
                <Button variant="outline" onClick={() => setAction('unban')}>
                  <ShieldCheck /> {t('unban')}
                </Button>
              ) : (
                <Button variant="destructive" onClick={() => setAction('ban')}>
                  <ShieldOff /> {t('ban')}
                </Button>
              )}
              <Button variant="outline" onClick={() => setAction('sessions')}>
                <LogOut className="rtl:-scale-x-100" /> {t('revokeSessions')}
              </Button>
              {data.user.twoFactorEnabled && (
                <Button variant="outline" onClick={() => setAction('twoFactor')}>
                  <KeyRound /> {t('resetTwoFactor')}
                </Button>
              )}
              {data.impersonation && (
                <Button variant="outline" onClick={() => setAction('impersonate')}>
                  <Eye /> {t('impersonate')}
                </Button>
              )}
            </div>
            {!data.impersonation && (
              <p className="mt-3 text-xs text-muted-foreground">{t('impersonationOff')}</p>
            )}
          </Section>
          {action && (
            <ReasonDialog
              open
              onOpenChange={(open) => !open && setAction(null)}
              title={t(`confirm.${action}.title`, { name: data.user.name })}
              description={t(`confirm.${action}.body`)}
              confirmLabel={t(`confirm.${action}.action`)}
              destructive={action !== 'unban' && action !== 'impersonate'}
              onConfirm={(reason) => run(action, reason)}
            />
          )}
        </>
      )}
    </div>
  );
}

export function UsersTab() {
  const t = useTranslations('adminUsers.list');
  const f = useFormat();
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, mutate } = useApi<AdminUsersResponse>('/admin/users', { q });

  if (open) return <UserDetail id={open} onBack={() => setOpen(null)} />;

  const columns: DataTableColumn<AdminUserRow>[] = [
    {
      id: 'user',
      header: t('user'),
      rowHeader: true,
      sortValue: (u) => u.name,
      cell: (u) => (
        <>
          <span className="flex items-center gap-2">
            {u.name}
            {u.banned && <StatusBadge value="banned" />}
          </span>
          <span className="block text-xs font-normal text-muted-foreground" dir="ltr">
            {u.email}
          </span>
        </>
      ),
    },
    {
      id: 'verified',
      header: t('verified'),
      sortValue: (u) => u.emailVerified,
      cell: (u) => <YesNo value={u.emailVerified} yes={t('yes')} no={t('no')} />,
    },
    {
      id: 'twoFactor',
      header: t('twoFactor'),
      sortValue: (u) => u.twoFactorEnabled,
      cell: (u) => <YesNo value={u.twoFactorEnabled} yes={t('yes')} no={t('no')} />,
    },
    {
      id: 'role',
      header: t('role'),
      className: 'text-muted-foreground',
      sortValue: (u) => u.role,
      cell: (u) => u.role,
    },
    {
      id: 'sessions',
      header: t('sessions'),
      align: 'end',
      className: 'font-mono text-xs',
      sortValue: (u) => u.sessions,
      cell: (u) => f.number(u.sessions),
    },
    {
      id: 'created',
      header: t('created'),
      className: 'font-mono text-xs text-muted-foreground',
      sortValue: (u) => new Date(u.createdAt),
      cell: (u) => f.date(u.createdAt),
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('actions')}</span>,
      align: 'end',
      cell: (u) => (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(u.id)}
          aria-label={t('openAria', { name: u.name })}
        >
          {t('open')}
        </Button>
      ),
    },
  ];

  return (
    <div className="grid gap-6">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setQ(input.trim());
        }}
      >
        <div className="grid w-full gap-1.5 sm:w-auto">
          <Label htmlFor="admin-user-search">{t('search')}</Label>
          <Input
            id="admin-user-search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-full sm:w-80"
            maxLength={120}
            dir="ltr"
          />
        </div>
        <Button type="submit" variant="outline">
          <Search /> {t('searchAction')}
        </Button>
      </form>
      {error ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : !data ? (
        <Skeleton className="h-64 rounded-xl" aria-label={t('loading')} />
      ) : data.data.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <Section title={t('results', { count: data.total })}>
          <DataTable
            dense
            caption={t('results', { count: data.total })}
            columns={columns}
            rows={data.data}
            getRowId={(u) => u.id}
          />
        </Section>
      )}
    </div>
  );
}
