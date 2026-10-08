'use client';

import { useState } from 'react';
import { Settings2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { PageHeader } from './primitives';

// BACKLOG 13.24 — notification preferences (GET|PATCH /notification-preferences): per kind,
// in-app and email. Phase 18 §2.8: emailDelivery is "active" when Studio sends email (Resend),
// "suppressed" when the user's address bounced or complained ("we can't email you"), and
// "pending_setup" with no email sender (core mode), where the email column says so.

export type PreferenceKind =
  | 'generation_complete'
  | 'approval_pending'
  | 'publication_failed'
  | 'auto_publish_failed'
  | 'milestone'
  | 'cost_alert'
  | 'cost_paused'
  | 'safety_review'
  | 'share_comment'
  | 'plan_quota'
  | 'connection_needs_reconnect'
  | 'tiktok_draft';

export interface PreferencesResponse {
  preferences: Record<string, { inApp: boolean; email: boolean }>;
  emailDelivery: 'pending_setup' | 'active' | 'suppressed';
}

/** Row order; labels are shell.preferences.kinds.<kind> in the catalogue. */
export const PREFERENCE_KINDS: readonly PreferenceKind[] = [
  'generation_complete',
  'approval_pending',
  'publication_failed',
  'auto_publish_failed',
  'milestone',
  'cost_alert',
  'cost_paused',
  'safety_review',
  'share_comment',
  'plan_quota',
  'connection_needs_reconnect',
  'tiktok_draft',
];

function PreferencesTable() {
  const t = useTranslations('shell.preferences');
  const te = useTranslations('email.preferences');
  const tc = useTranslations('common.states');
  const errorMessage = useErrorMessage();
  const res = useApi<PreferencesResponse>('/notification-preferences');
  const [saving, setSaving] = useState<string | null>(null);

  const change = async (kind: PreferenceKind, channel: 'inApp' | 'email', value: boolean) => {
    setSaving(`${kind}.${channel}`);
    try {
      const updated = await api<PreferencesResponse>('/notification-preferences', {
        method: 'PATCH',
        body: { [kind]: { [channel]: value } },
      });
      await res.mutate(updated, { revalidate: false });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  if (res.error) return <p className="text-sm text-destructive">{errorMessage(res.error)}</p>;
  if (!res.data) return <p className="text-sm text-muted-foreground">{tc('loading')}</p>;
  const pendingEmail = res.data.emailDelivery === 'pending_setup';
  return (
    <>
      {res.data.emailDelivery === 'suppressed' && (
        <p role="status" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
          {te('suppressed')}
        </p>
      )}
      <Table aria-label={t('tableAria')}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="px-0">
              {t('notification')}
            </TableHead>
            <TableHead scope="col" className="text-center">
              {t('inApp')}
            </TableHead>
            <TableHead scope="col" className="text-center">
              {t('email')}
              {pendingEmail && (
                <span className="block text-[0.65rem] font-normal">{t('pendingSetup')}</span>
              )}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {PREFERENCE_KINDS.map((kind) => {
            // Operator decision 2026-10-04: cost notifications are worded as limits, not budgets.
            const label =
              kind === 'cost_alert' || kind === 'cost_paused'
                ? t(`limitKinds.${kind}`)
                : t(`kinds.${kind}`);
            const pref = res.data?.preferences[kind] ?? { inApp: true, email: false };
            return (
              <TableRow key={kind}>
                <th
                  scope="row"
                  className="py-2 pe-2 text-start align-middle font-normal whitespace-normal"
                >
                  {label}
                </th>
                <TableCell className="text-center">
                  <Switch
                    aria-label={t('switchInApp', { label })}
                    checked={pref.inApp}
                    disabled={saving !== null}
                    onCheckedChange={(v) => void change(kind, 'inApp', v)}
                  />
                </TableCell>
                <TableCell className="text-center">
                  <Switch
                    aria-label={t('switchEmail', { label })}
                    checked={pref.email}
                    disabled={saving !== null}
                    onCheckedChange={(v) => void change(kind, 'email', v)}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}

/** Phase 18: the description follows the email delivery state (SWR shares the request). */
function usePreferencesDescription(): string {
  const t = useTranslations('shell.preferences');
  const te = useTranslations('email.preferences');
  const res = useApi<PreferencesResponse>('/notification-preferences');
  const pending = !res.data || res.data.emailDelivery === 'pending_setup';
  return pending ? t('description') : te('description');
}

function PreferencesDescription() {
  return <DialogDescription>{usePreferencesDescription()}</DialogDescription>;
}

/** 25.12: the same preferences inline, as the Settings → Notifications page. */
export function NotificationPreferencesScreen() {
  const tn = useTranslations('settingsNav');
  return (
    <>
      <PageHeader
        eyebrow={tn('title')}
        title={tn('items.notifications')}
        description={usePreferencesDescription()}
      />
      <div className="max-w-2xl border-t border-border pt-4">
        <PreferencesTable />
      </div>
    </>
  );
}

export function NotificationPreferencesButton() {
  const t = useTranslations('shell.preferences');
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('button')}>
          <Settings2 />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <PreferencesDescription />
        </DialogHeader>
        <PreferencesTable />
      </DialogContent>
    </Dialog>
  );
}
