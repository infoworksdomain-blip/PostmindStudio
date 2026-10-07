'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  Building,
  Check,
  CreditCard,
  Download,
  LogOut,
  MessageSquarePlus,
  Settings,
  ShieldCheck,
  UserRound,
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { APP_HOME } from '@/lib/auth/page-guard';
import { hardNavigate } from '@/lib/client/navigate';
import { useBusiness } from '../business-context';
import { FeedbackDialog } from '../feedback-dialog';
import { LanguageMenuSub } from '../i18n/language-switcher';
import { ThemeMenuRadioItems } from '../theme-switcher';
import { setActiveOrganisation, signOut, useMe, type Me } from './use-me';

// Phase 18 §3 — the AppShell's account menu. Switching organisation sets Better Auth's active
// organisation and reloads, because every server-side read is scoped to it; the chosen business
// belongs to the old organisation, so it is cleared. In core mode Core signs people in and out,
// so only the organisation name shows. 25.4: the menu is the one home for the personal controls
// that used to crowd the top bar (organisation, appearance, language, feedback, export), and it
// renders before /me answers (or when it fails) so appearance and language stay reachable.

function initials(me: Me): string {
  const source = me.user.name?.trim() || me.user.email || '?';
  const parts = source.split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]?.[0]}${parts[1]?.[0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}

function OrganisationItems({ me }: { me: Me }) {
  const t = useTranslations('shell.account');
  const { setBusinessId } = useBusiness();
  const [switching, setSwitching] = useState(false);
  const others = me.organisations.filter((o) => o.id !== me.organisation.id);
  if (me.identityMode === 'core' || others.length === 0)
    return (
      <DropdownMenuLabel className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
        <Building aria-hidden className="size-3.5" />
        <span className="truncate">{me.organisation.name}</span>
      </DropdownMenuLabel>
    );

  async function choose(id: string) {
    setSwitching(true);
    try {
      if (!(await setActiveOrganisation(id))) throw new Error('switch failed');
      setBusinessId(null);
      hardNavigate(APP_HOME);
    } catch {
      toast.error(t('switchFailed'));
      setSwitching(false);
    }
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        disabled={switching}
        aria-label={t('switcherAria', { name: me.organisation.name })}
      >
        <Building aria-hidden className="text-muted-foreground" />
        <span className="truncate">{me.organisation.name}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-60">
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
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function AccountLinks({ me }: { me: Me }) {
  const t = useTranslations('shell.account');
  const tn = useTranslations('shell.nav.items');
  return (
    <>
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
        <DropdownMenuItem asChild>
          <Link href="/account/security">
            <ShieldCheck aria-hidden /> {t('security')}
          </Link>
        </DropdownMenuItem>
      )}
      {/* 25.4: Export data moved here from the sidebar. */}
      <DropdownMenuItem asChild>
        <Link href="/account/export">
          <Download aria-hidden /> {tn('export')}
        </Link>
      </DropdownMenuItem>
    </>
  );
}

function MenuTrigger({ me }: { me: Me | undefined }) {
  const t = useTranslations('shell.account');
  return (
    <DropdownMenuTrigger asChild>
      <Button
        variant="ghost"
        size="icon"
        data-shell="account-menu"
        aria-label={
          me
            ? t('userMenuAria', { name: me.user.name ?? me.user.email ?? me.user.id })
            : t('menuAria')
        }
        className="rounded-full"
      >
        {me ? (
          <span
            aria-hidden
            className="grid size-8 place-items-center rounded-full bg-foreground text-[0.7rem] font-semibold tracking-wide text-background"
          >
            {initials(me)}
          </span>
        ) : (
          <UserRound aria-hidden />
        )}
      </Button>
    </DropdownMenuTrigger>
  );
}

export function AccountMenu({ me }: { me: Me | undefined }) {
  const t = useTranslations('shell.account');
  const [signingOut, setSigningOut] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  async function onSignOut() {
    setSigningOut(true);
    try {
      if (!(await signOut())) throw new Error('sign-out failed');
      hardNavigate('/');
    } catch {
      toast.error(t('signOutFailed'));
      setSigningOut(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <MenuTrigger me={me} />
        <DropdownMenuContent align="end" className="w-64">
          {me && (
            <>
              <DropdownMenuLabel className="grid gap-0.5">
                <span className="truncate text-sm">{me.user.name ?? me.user.id}</span>
                {me.user.email && (
                  <span className="truncate text-xs font-normal text-muted-foreground">
                    {me.user.email}
                  </span>
                )}
              </DropdownMenuLabel>
              <OrganisationItems me={me} />
              <DropdownMenuSeparator />
              <AccountLinks me={me} />
              <DropdownMenuSeparator />
            </>
          )}
          <ThemeMenuRadioItems />
          <DropdownMenuSeparator />
          <LanguageMenuSub />
          <DropdownMenuItem onSelect={() => setFeedbackOpen(true)}>
            <MessageSquarePlus aria-hidden /> {t('feedback')}
          </DropdownMenuItem>
          {me?.identityMode === 'standalone' && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={signingOut} onSelect={() => void onSignOut()}>
                <LogOut aria-hidden className="rtl:-scale-x-100" /> {t('signOut')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </>
  );
}

/** The top bar's account menu (it renders while /me loads or fails, with the personal controls). */
export function AccountControls() {
  const { data } = useMe();
  return <AccountMenu me={data?.me} />;
}
