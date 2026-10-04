'use client';

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { useFormat } from '@/lib/client/format';
import { useProjectName } from '@/lib/client/use-project-name';
import { useShowCosts } from './account/use-show-costs';
import type { Messages } from '@/lib/i18n/messages';

// BACKLOG 16.5 — notifications are stored with a message key + ICU parameters (notifications
// .message_key / .message_params, written by the server-side notifier) and rendered here in the
// reader's locale. Rows written before 16.5, or with a key this build's catalogue does not know,
// fall back to the stored title/body (English). A `platform` parameter holds the platform id and
// is shown with the localised platform label.
// Operator decision 2026-10-04: customers never see generation cost. A cost notification (budget
// alert or pause) is shown to them as a plain "limit" sentence without amounts or percentages;
// platform staff read the keyed text with figures.

/** Keys with a title and body (costPlain groups the 21.5 customer cost wording). */
type NotificationKey = Exclude<keyof Messages['notifications'], 'costPlain'>;

/** Keys whose `name` parameter is a project name (17.9: '' = unnamed). */
const PROJECT_NAME_KEYS: ReadonlySet<string> = new Set([
  'generationReady',
  'generationAutoApproved',
  'publicationFailed',
  'approvalPending',
  'autoPublishFailed',
  'scheduleQueueOff',
  'scheduleNoPlatform',
  'scheduleNoFreeSlot',
  'shareComment',
  'milestoneViews',
  'milestoneComments',
  'autoResumedMonthly',
  'autoResumedDaily',
  'costProjectPaused',
  'costProjectAlert',
  'costProjectOverBudget',
  'safetyReviewStaff',
  'safetyReviewOpened',
  'safetyReviewAllowed',
  'safetyReviewBlocked',
]);

/** Customer wording (notifications.costPlain.*) for each cost notification key. */
const PLAIN_COST_KEYS = {
  costProjectAlert: 'projectAlert',
  costProjectPaused: 'projectPaused',
  costProjectOverBudget: 'projectPaused',
  costDailyAlert: 'dailyAlert',
  costDailyPaused: 'dailyPaused',
  costMonthlyAlert: 'monthlyAlert',
  costMonthlyPaused: 'monthlyPaused',
} as const;

type PlainCostKey = (typeof PLAIN_COST_KEYS)[keyof typeof PLAIN_COST_KEYS] | 'generic';

const COST_KINDS: ReadonlySet<string> = new Set(['cost_alert', 'cost_paused']);

/** The customer wording for a cost notification, or null when it is not one. */
export function plainCostKey(n: LocalisableNotification): PlainCostKey | null {
  const key = n.messageKey ?? '';
  if (Object.prototype.hasOwnProperty.call(PLAIN_COST_KEYS, key))
    return PLAIN_COST_KEYS[key as keyof typeof PLAIN_COST_KEYS];
  // Any other cost row (an older row without a key, or a staff-only key) gets the generic line.
  return (n.kind && COST_KINDS.has(n.kind)) || key.startsWith('cost') ? 'generic' : null;
}

export interface LocalisableNotification {
  /** The notification kind (cost_alert, cost_paused, …), when known. */
  kind?: string;
  title: string;
  body: string;
  messageKey?: string | null;
  messageParams?: Record<string, string | number> | null;
}

export function useNotificationText(): (n: LocalisableNotification) => {
  title: string;
  body: string;
} {
  const t = useTranslations('notifications');
  const f = useFormat();
  const projectName = useProjectName();
  const showCosts = useShowCosts();
  return useCallback(
    (n: LocalisableNotification) => {
      const plain = showCosts ? null : plainCostKey(n);
      if (plain) {
        const name = projectName(
          typeof n.messageParams?.name === 'string' ? n.messageParams.name : '',
        );
        return {
          title: t(`costPlain.${plain}.title`, { name }),
          body: t(`costPlain.${plain}.body`),
        };
      }
      const key = n.messageKey as NotificationKey | null | undefined;
      if (!key || !t.has(`${key}.title`) || !t.has(`${key}.body`)) {
        return { title: n.title, body: n.body };
      }
      const params = { ...(n.messageParams ?? {}) };
      if (typeof params.platform === 'string') params.platform = f.platform(params.platform);
      // 17.9: an unnamed project is sent as name '' — "Untitled video" in the reader's language.
      if (typeof params.name === 'string' && PROJECT_NAME_KEYS.has(key))
        params.name = projectName(params.name);
      try {
        const title = t(`${key}.title`, params);
        const body = t(`${key}.body`, params);
        // A formatting failure (e.g. a parameter missing from the row) renders the key path
        // (StudioIntlProvider's getMessageFallback) — the stored text is still correct then.
        const failed =
          title === `notifications.${key}.title` || body === `notifications.${key}.body`;
        return failed ? { title: n.title, body: n.body } : { title, body };
      } catch {
        // Tests run with missingKeys="throw".
        return { title: n.title, body: n.body };
      }
    },
    [t, f, projectName, showCosts],
  );
}
