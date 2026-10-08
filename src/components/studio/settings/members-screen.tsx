'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Loader2, Mail, RotateCw, ShieldCheck, UserPlus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { api, ApiError, useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState, ErrorState, PageHeader, Section } from '../primitives';
import { cn } from '@/lib/utils';
import { meterFillClass } from '../usage-meter';
import { useSettingsError } from './settings-errors';

// Phase 18 §3 /settings/members — the members table (role select, remove), pending invitations
// (resend, revoke), the seat meter and an upgrade prompt at the seat limit. Studio's rules are
// mirrored here only to hide controls that would be refused (the API decides): admins cannot
// touch owners, ownership moves by transfer (organisation settings), the last owner stays.

export const ROLES = ['owner', 'admin', 'publisher', 'creator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const INVITE_ROLES = ['admin', 'publisher', 'creator', 'viewer'] as const;

export interface MemberRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  joinedAt: string;
  twoFactorEnabled: boolean;
  isYou: boolean;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  invitedAt: string;
  expiresAt: string;
}

export interface MembersResponse {
  ok: true;
  members: MemberRow[];
  invitations: InvitationRow[];
  seats: { used: number; limit: number | null };
  canManage: boolean;
}

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value);

function SeatMeter({ used, limit }: { used: number; limit: number | null }) {
  const t = useTranslations('members.seats');
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const full = limit !== null && used >= limit;
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{t('label')}</span>
        <span className="tabular-nums text-muted-foreground">
          {limit === null ? t('unlimited', { used }) : t('usedOf', { used, limit })}
        </span>
      </div>
      {limit !== null && (
        <div
          role="meter"
          aria-label={t('label')}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={used}
          className="h-1.5 overflow-hidden rounded-full bg-secondary"
        >
          <div className={cn('h-full', meterFillClass(pct))} style={{ inlineSize: `${pct}%` }} />
        </div>
      )}
      {full && (
        <p className="text-sm">
          {t('full')}{' '}
          <Link href="/settings/billing" className="font-medium underline underline-offset-4">
            {t('upgrade')}
          </Link>
        </p>
      )}
    </div>
  );
}

/** An invite refused because the plan's seats are used up (Better Auth membershipLimit). */
export function isSeatLimitError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return (
    ['quota_exceeded', 'plan_tier', 'plan_required'].includes(err.code) ||
    err.details?.reason === 'seat_limit'
  );
}

function InviteForm({ disabled, onInvited }: { disabled: boolean; onInvited: () => void }) {
  const t = useTranslations('members.invite');
  const tr = useTranslations('members.roles');
  const errorMessage = useSettingsError();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof INVITE_ROLES)[number]>('creator');
  const [sending, setSending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSending(true);
    try {
      await api('/members/invitations', { method: 'POST', body: { email: email.trim(), role } });
      toast.success(t('sent', { email: email.trim() }));
      setEmail('');
      onInvited();
    } catch (err) {
      // Seat limit: Track C's global UpgradeDialog opens from api() (upgrade-events.ts); here the
      // list refreshes so the seat meter shows the plan is full, with its upgrade link.
      if (isSeatLimitError(err)) {
        toast.error(t('seatLimit'));
        onInvited();
      } else toast.error(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-60 flex-1 gap-1.5">
          <Label htmlFor="invite-email">{t('email')}</Label>
          <Input
            id="invite-email"
            type="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('emailPlaceholder')}
            required
            disabled={disabled}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="invite-role">{t('role')}</Label>
          <NativeSelect
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as (typeof INVITE_ROLES)[number])}
            disabled={disabled}
          >
            {INVITE_ROLES.map((r) => (
              <option key={r} value={r}>
                {tr(r)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" disabled={disabled || sending || !email.trim()}>
          {sending ? <Loader2 className="animate-spin" /> : <UserPlus />}
          {t('send')}
        </Button>
        <p className="basis-full text-xs text-muted-foreground">{t('hint')}</p>
      </form>
    </>
  );
}

function RoleCell({
  member,
  myRole,
  canManage,
  onChanged,
}: {
  member: MemberRow;
  myRole: Role | null;
  canManage: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('members.table');
  const tr = useTranslations('members.roles');
  const errorMessage = useSettingsError();
  const [saving, setSaving] = useState(false);
  const label = isRole(member.role) ? tr(member.role) : member.role;
  // Only owners touch owners; ownership itself moves by transfer, never from this select.
  const editable = canManage && (member.role !== 'owner' || myRole === 'owner');
  if (!editable) return <span>{label}</span>;
  const choices = ROLES.filter((r) => r !== 'owner' || member.role === 'owner');

  async function change(role: string) {
    setSaving(true);
    try {
      await api(`/members/${encodeURIComponent(member.id)}`, { method: 'PATCH', body: { role } });
      toast.success(t('roleChanged', { name: member.name, role: isRole(role) ? tr(role) : role }));
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <NativeSelect
      size="sm"
      wrapperClassName="w-auto"
      aria-label={t('roleFor', { name: member.name })}
      value={member.role}
      disabled={saving}
      onChange={(e) => void change(e.target.value)}
    >
      {choices.map((r) => (
        <option key={r} value={r}>
          {tr(r)}
        </option>
      ))}
    </NativeSelect>
  );
}

function MembersTable({ data, onChanged }: { data: MembersResponse; onChanged: () => void }) {
  const t = useTranslations('members.table');
  const f = useFormat();
  const errorMessage = useSettingsError();
  const [removing, setRemoving] = useState<MemberRow | null>(null);
  const me = data.members.find((m) => m.isYou);
  const myRole = me && isRole(me.role) ? me.role : null;

  const columns: Array<DataTableColumn<MemberRow>> = [
    {
      id: 'member',
      header: t('member'),
      sortValue: (m) => m.name,
      cell: (m) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            {m.name}
            {m.isYou && (
              <StatusPill size="sm" className="font-normal">
                {t('you')}
              </StatusPill>
            )}
            {m.twoFactorEnabled && (
              <ShieldCheck aria-label={t('twoFactor')} className="size-3.5 text-success" />
            )}
          </div>
          <div className="text-xs text-muted-foreground" dir="ltr">
            {m.email}
          </div>
        </div>
      ),
    },
    {
      id: 'role',
      header: t('role'),
      cell: (m) => (
        <RoleCell member={m} myRole={myRole} canManage={data.canManage} onChanged={onChanged} />
      ),
    },
    {
      id: 'joined',
      header: t('joined'),
      sortValue: (m) => m.joinedAt,
      className: 'text-muted-foreground whitespace-nowrap',
      cell: (m) => f.date(m.joinedAt),
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('actions')}</span>,
      mobileLabel: t('actions'),
      align: 'end',
      cell: (m) => {
        const removable = data.canManage && (m.role !== 'owner' || myRole === 'owner');
        if (!removable) return null;
        return (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRemoving(m)}
            aria-label={m.isYou ? t('leave') : t('removeAria', { name: m.name })}
          >
            <X /> {m.isYou ? t('leave') : t('remove')}
          </Button>
        );
      },
    },
  ];

  return (
    <>
      <DataTable
        caption={t('caption')}
        columns={columns}
        rows={data.members}
        getRowId={(m) => m.id}
        responsive="stack"
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('removeTitle', { name: removing?.name ?? '' })}
        description={t('removeBody')}
        confirmLabel={t('remove')}
        onConfirm={async () => {
          if (!removing) return true;
          try {
            await api(`/members/${encodeURIComponent(removing.id)}`, { method: 'DELETE' });
            toast.success(t('removed', { name: removing.name }));
            onChanged();
            return true;
          } catch (err) {
            toast.error(errorMessage(err));
            return false;
          }
        }}
      />
    </>
  );
}

function Invitations({
  invitations,
  onChanged,
}: {
  invitations: InvitationRow[];
  onChanged: () => void;
}) {
  const t = useTranslations('members.pending');
  const tr = useTranslations('members.roles');
  const f = useFormat();
  const errorMessage = useSettingsError();
  const [busy, setBusy] = useState<string | null>(null);
  if (invitations.length === 0) return <p className="text-sm text-muted-foreground">{t('none')}</p>;

  async function act(inv: InvitationRow, action: 'resend' | 'revoke') {
    setBusy(inv.id);
    try {
      const path = `/members/invitations/${encodeURIComponent(inv.id)}`;
      if (action === 'resend') await api(`${path}/resend`, { method: 'POST' });
      else await api(path, { method: 'DELETE' });
      toast.success(action === 'resend' ? t('resent', { email: inv.email }) : t('revoked'));
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="divide-y divide-border border-y border-border">
      {invitations.map((inv) => (
        <li key={inv.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
          <Mail aria-hidden className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="font-medium" dir="ltr">
              {inv.email}
            </span>
            <span className="text-muted-foreground">
              {' · '}
              {isRole(inv.role) ? tr(inv.role) : inv.role}
              {' · '}
              {t('expires', { date: f.date(inv.expiresAt, { day: 'numeric', month: 'short' }) })}
            </span>
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={busy === inv.id}
            onClick={() => void act(inv, 'resend')}
            aria-label={t('resendAria', { email: inv.email })}
          >
            <RotateCw /> {t('resend')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy === inv.id}
            onClick={() => void act(inv, 'revoke')}
            aria-label={t('revokeAria', { email: inv.email })}
          >
            {t('revoke')}
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function MembersScreen() {
  const t = useTranslations('members.page');
  const { data, error, mutate } = useApi<MembersResponse>('/members');
  const refresh = () => void mutate();
  const header = (
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')} />
  );
  if (error)
    return (
      <>
        {header}
        <ErrorState error={error} onRetry={refresh} />
      </>
    );
  if (!data)
    return (
      <>
        {header}
        <Skeleton className="h-72 rounded-xl" aria-label={t('loading')} />
      </>
    );
  const full = data.seats.limit !== null && data.seats.used >= data.seats.limit;
  return (
    <>
      {header}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-10 xl:grid-cols-[minmax(0,1fr)_18rem] xl:items-start">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-10">
          {data.canManage && (
            <Section title={t('inviteTitle')} description={t('inviteDescription')}>
              <InviteForm disabled={full} onInvited={refresh} />
            </Section>
          )}
          <Section title={t('membersTitle', { count: data.members.length })}>
            {data.members.length === 0 ? (
              <EmptyState title={t('empty')} />
            ) : (
              <MembersTable data={data} onChanged={refresh} />
            )}
          </Section>
          {data.canManage && (
            <Section title={t('pendingTitle')}>
              <Invitations invitations={data.invitations} onChanged={refresh} />
            </Section>
          )}
        </div>
        <Section title={t('seatsTitle')} variant="panel" className="xl:sticky xl:top-20">
          <SeatMeter used={data.seats.used} limit={data.seats.limit} />
        </Section>
      </div>
    </>
  );
}
