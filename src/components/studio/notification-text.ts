'use client';

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { useFormat } from '@/lib/client/format';
import { useProjectName } from '@/lib/client/use-project-name';
import type { Messages } from '@/lib/i18n/messages';

// BACKLOG 16.5 — notifications are stored with a message key + ICU parameters (notifications
// .message_key / .message_params, written by the server-side notifier) and rendered here in the
// reader's locale. Rows written before 16.5, or with a key this build's catalogue does not know,
// fall back to the stored title/body (English). A `platform` parameter holds the platform id and
// is shown with the localised platform label.

type NotificationKey = keyof Messages['notifications'];

/** Keys whose `name` parameter is a project name (17.9: '' = unnamed). */
const PROJECT_NAME_KEYS: ReadonlySet<string> = new Set([
  'generationReady',
  'generationAutoApproved',
  'publicationFailed',
  'approvalPending',
  'autoPublishFailed',
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

export interface LocalisableNotification {
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
  return useCallback(
    (n: LocalisableNotification) => {
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
    [t, f, projectName],
  );
}
