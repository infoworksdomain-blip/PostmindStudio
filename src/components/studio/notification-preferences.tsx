'use client';

import { useState } from 'react';
import { Settings2 } from 'lucide-react';
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
import { api, errorMessage, useApi } from '@/lib/client/api';

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

export const PREFERENCE_ROWS: Array<{ kind: PreferenceKind; label: string }> = [
  { kind: 'generation_complete', label: 'Video ready for review' },
  { kind: 'approval_pending', label: 'Approval waiting over 2 hours' },
  { kind: 'publication_failed', label: 'Publishing failed' },
  { kind: 'auto_publish_failed', label: 'Auto-publish gave up' },
  { kind: 'milestone', label: 'Milestones (10k views, 100 comments)' },
  { kind: 'cost_alert', label: 'Budget alerts' },
  { kind: 'cost_paused', label: 'Generation paused by a budget' },
  { kind: 'safety_review', label: 'Content-safety reviews' },
  { kind: 'share_comment', label: 'Feedback on a preview link' },
  { kind: 'plan_quota', label: 'Plan usage alerts (80% and 100%)' },
];

function PreferencesTable() {
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
  if (!res.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const pendingEmail = res.data.emailDelivery === 'pending_setup';
  return (
    <table aria-label="Notification preferences" className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th scope="col" className="py-1 font-normal">
            Notification
          </th>
          <th scope="col" className="py-1 text-center font-normal">
            In-app
          </th>
          <th scope="col" className="py-1 text-center font-normal">
            Email{pendingEmail && <span className="block text-[0.65rem]">pending setup</span>}
          </th>
        </tr>
      </thead>
      <tbody>
        {PREFERENCE_ROWS.map(({ kind, label }) => {
          const pref = res.data?.preferences[kind] ?? { inApp: true, email: false };
          return (
            <tr key={kind} className="border-t border-border/60">
              <th scope="row" className="py-2 pr-2 text-left font-normal">
                {label}
              </th>
              <td className="py-2 text-center">
                <Switch
                  aria-label={`${label}: in-app`}
                  checked={pref.inApp}
                  disabled={saving !== null}
                  onCheckedChange={(v) => void change(kind, 'inApp', v)}
                />
              </td>
              <td className="py-2 text-center">
                <Switch
                  aria-label={`${label}: email`}
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
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Notification preferences">
          <Settings2 />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Notification preferences</DialogTitle>
          <DialogDescription>
            Choose what reaches you. Email: pending setup — your email choices are saved and apply
            once email delivery is connected.
          </DialogDescription>
        </DialogHeader>
        <PreferencesTable />
      </DialogContent>
    </Dialog>
  );
}
