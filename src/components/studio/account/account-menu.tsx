'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  Building,
  Check,
  CreditCard,
  ChevronsUpDown,
  LogOut,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useBusiness } from '../business-context';
import { setActiveOrganisation, signOut, useMe, type Me } from './use-me';

// Phase 18 §3 — the AppShell header's organisation switcher and user menu (standalone mode).
// Switching organisation sets Better Auth's active organisation and reloads, because every
// server-side read is scoped to it; the chosen business belongs to the old organisation, so it
// is cleared. In core mode Core signs people in and out, so only the organisation name shows.

function initials(me: Me): string {
  const source = me.user.name?.trim() || me.user.email || '?';
  const parts = source.split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]?.[0]}${parts[1]?.[0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}

export function OrganisationSwitcher({ me }: { me: Me }) {
  const t = useTranslations('shell.account');
  const { setBusinessId } = useBusiness();
  const [switching, setSwitching] = useState(false);
  const others = me.organisations.filter((o) => o.id !== me.organisation.id);
  if (me.identityMode === 'core' || others.length === 0)
    return (
      <span
        className="hidden max-w-40 truncate text-sm font-medium lg:inline"
        title={me.organisation.name}
      >
        {me.organisation.name}
      </span>
    );

  async function choose(id: string) {
    setSwitching(true);
    try {
      if (!(await setActiveOrganisation(id))) throw new Error('switch failed');
      setBusinessId(null);
      window.location.assign('/projects');
    } catch {
      toast.error(t('switchFailed'));
      setSwitching(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={switching}
          aria-label={t('switcherAria', { name: me.organisation.name })}
          className="max-w-48 gap-1.5"
        >
          <Building aria-hidden className="text-muted-foreground" />
          {/* The header is full below xl (business picker, language, bell, theme, user menu). */}
          <span className="hidden truncate xl:inline">{me.organisation.name}</span>
          <ChevronsUpDown aria-hidden className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t('organisations')}
        </DropdownMenuLabel>
        {me.organisations.map((org) => {
          const current = org.id === me.organisation.id;
          return (
            <DropdownMenuItem
              key={org.id}
              disabled={current}
              onSelect={() => void choose(org.id)}
              className="justify-between"
            >
              <span className="truncate">{org.name}</span>
              {current && <Check aria-label={t('current')} className="size-4" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/welcome?new=organisation">{t('newOrganisation')}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function UserMenu({ me }: { me: Me }) {
  const t = useTranslations('shell.account');
  const [signingOut, setSigningOut] = useState(false);

  async function onSignOut() {
    setSigningOut(true);
    try {
      if (!(await signOut())) throw new Error('sign-out failed');
      window.location.assign('/');
    } catch {
      toast.error(t('signOutFailed'));
      setSigningOut(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('userMenuAria', { name: me.user.name ?? me.user.email ?? me.user.id })}
          className="rounded-full"
        >
          <span
            aria-hidden
            className="grid size-8 place-items-center rounded-full bg-foreground text-[0.7rem] font-semibold tracking-wide text-background"
          >
            {initials(me)}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="grid gap-0.5">
          <span className="truncate text-sm">{me.user.name ?? me.user.id}</span>
          {me.user.email && (
            <span className="truncate text-xs font-normal text-muted-foreground">
              {me.user.email}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/organisation">
            <Settings aria-hidden /> {t('organisationSettings')}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings/members">
            <Users aria-hidden /> {t('members')}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings/billing">
            <CreditCard aria-hidden /> {t('billing')}
          </Link>
        </DropdownMenuItem>
        {me.identityMode === 'standalone' && (
          <>
            <DropdownMenuItem asChild>
              <Link href="/account/security">
                <ShieldCheck aria-hidden /> {t('security')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={signingOut} onSelect={() => void onSignOut()}>
              <LogOut aria-hidden className="rtl:-scale-x-100" /> {t('signOut')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Header cluster: nothing until /me answers (errors hide it; the page shows its own state). */
export function AccountControls() {
  const { data } = useMe();
  if (!data) return null;
  return (
    <>
      <OrganisationSwitcher me={data.me} />
      <UserMenu me={data.me} />
    </>
  );
}
