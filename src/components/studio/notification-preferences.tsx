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
import { api, useApi, useErrorMessage } from '@/lib/client/api';

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
  | 'connection_needs_reconnect';

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
      <table aria-label={t('tableAria')} className="w-full text-sm">
        <thead>
          <tr className="text-start text-xs text-muted-foreground">
            <th scope="col" className="py-1 text-start font-normal">
              {t('notification')}
            </th>
            <th scope="col" className="py-1 text-center font-normal">
              {t('inApp')}
            </th>
            <th scope="col" className="py-1 text-center font-normal">
              {t('email')}
              {pendingEmail && <span className="block text-[0.65rem]">{t('pendingSetup')}</span>}
            </th>
          </tr>
        </thead>
        <tbody>
          {PREFERENCE_KINDS.map((kind) => {
            // Operator decision 2026-10-04: cost notifications are worded as limits, not budgets.
            const label =
              kind === 'cost_alert' || kind === 'cost_paused'
                ? t(`limitKinds.${kind}`)
                : t(`kinds.${kind}`);
            const pref = res.data?.preferences[kind] ?? { inApp: true, email: false };
            return (
              <tr key={kind} className="border-t border-border/60">
                <th scope="row" className="py-2 pe-2 text-start font-normal">
                  {label}
                </th>
                <td className="py-2 text-center">
                  <Switch
                    aria-label={t('switchInApp', { label })}
                    checked={pref.inApp}
                    disabled={saving !== null}
                    onCheckedChange={(v) => void change(kind, 'inApp', v)}
                  />
                </td>
                <td className="py-2 text-center">
                  <Switch
                    aria-label={t('switchEmail', { label })}
                    checked={pref.email}
                    disabled={saving !== null}
                    onCheckedChange={(v) => void change(kind, 'email', v)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/** Phase 18: the dialog description follows the email delivery state (SWR shares the request). */
function PreferencesDescription() {
  const t = useTranslations('shell.preferences');
  const te = useTranslations('email.preferences');
  const res = useApi<PreferencesResponse>('/notification-preferences');
  const pending = !res.data || res.data.emailDelivery === 'pending_setup';
  return <DialogDescription>{pending ? t('description') : te('description')}</DialogDescription>;
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
