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
// in-app and email. Email choices are saved now; delivery waits for an email channel (13.33),
// so the email column says "pending setup".

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
  | 'plan_quota';

export interface PreferencesResponse {
  preferences: Record<string, { inApp: boolean; email: boolean }>;
  emailDelivery: 'pending_setup' | 'active';
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
];

function PreferencesTable() {
  const t = useTranslations('shell.preferences');
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
          const label = t(`kinds.${kind}`);
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
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <PreferencesTable />
      </DialogContent>
    </Dialog>
  );
}
