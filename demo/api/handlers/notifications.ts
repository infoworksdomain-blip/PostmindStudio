// In-app notifications (services/notifications.ts): newest first, cursor paging, unread count,
// mark one read / read all. Titles and bodies follow the real event writers
// (notifications/events.ts, cost/guard.ts).
import { PROJECTS } from '../ids';
import { DemoHttpError, route } from '../registry';

interface DemoNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LOADED_AT = Date.now();
const ago = (ms: number) => new Date(LOADED_AT - ms).toISOString();

const rows: DemoNotification[] = [
  {
    id: 'ntf-spring-ready',
    kind: 'generation_complete',
    title: `“${PROJECTS.springMenu.name}” is ready for review`,
    body: 'Every variant passed the quality checks. Review it, then approve or publish.',
    link: `/projects/${PROJECTS.springMenu.id}`,
    readAt: null,
    createdAt: ago(12 * MIN),
  },
  {
    id: 'ntf-wholesale-failed',
    kind: 'publication_failed',
    title: `Publishing “${PROJECTS.wholesale.name}” to linkedin_video failed`,
    body: 'LinkedIn rejected the upload: the video is longer than the 10 minutes a page post allows — open the project to retry.',
    link: `/projects/${PROJECTS.wholesale.id}`,
    readAt: null,
    createdAt: ago(2 * DAY - 25 * MIN),
  },
  {
    id: 'ntf-christmas-80',
    kind: 'cost_alert',
    title: `“${PROJECTS.christmas.name}” has used 80% of its budget`,
    body: '£19.20 spent. Generation pauses at 90% of the budget; it can then be raised on the project page.',
    link: `/projects/${PROJECTS.christmas.id}`,
    readAt: null,
    createdAt: ago(3 * HOUR),
  },
  {
    id: 'ntf-five-bakes-waiting',
    kind: 'approval_pending',
    title: `“${PROJECTS.fiveBakes.name}” is waiting for approval`,
    body: 'It has been ready for review for more than 2 hours.',
    link: `/projects/${PROJECTS.fiveBakes.id}`,
    readAt: null,
    createdAt: ago(5 * HOUR),
  },
  {
    id: 'ntf-ritual-auto',
    kind: 'generation_complete',
    title: `“${PROJECTS.morningRitual.name}” is generated and was auto-approved`,
    body: 'The video passed every quality check and your review policy approved it automatically. It auto-publishes to TikTok and YouTube Shorts on schedule.',
    link: `/projects/${PROJECTS.morningRitual.id}`,
    readAt: null,
    createdAt: ago(9 * HOUR),
  },
  {
    id: 'ntf-christmas-paused',
    kind: 'cost_paused',
    title: `Generation paused: “${PROJECTS.christmas.name}” reached 90% of its budget`,
    body: '£21.60 spent. Open the project, raise its budget (Raise budget), then press Generate again.',
    link: `/projects/${PROJECTS.christmas.id}`,
    readAt: ago(DAY),
    createdAt: ago(DAY + 2 * HOUR),
  },
  {
    id: 'ntf-class-ready',
    kind: 'generation_complete',
    title: `“${PROJECTS.sourdoughClass.name}” is ready for review`,
    body: 'Every variant passed the quality checks. Review it, then approve or publish.',
    link: `/projects/${PROJECTS.sourdoughClass.id}`,
    readAt: ago(6 * DAY),
    createdAt: ago(7 * DAY),
  },
  {
    id: 'ntf-daily-provider',
    kind: 'cost_alert',
    title: '80% of today’s runway budget used',
    body: '£40.00 spent today (UTC) with runway. At 100% Studio routes to fallback providers where they exist.',
    link: '/analytics',
    readAt: ago(9 * DAY),
    createdAt: ago(9 * DAY + HOUR),
  },
  {
    id: 'ntf-class-x-failed',
    kind: 'publication_failed',
    title: `Publishing “${PROJECTS.sourdoughClass.name}” to x failed`,
    body: 'The X connection needs reconnecting: the access token was revoked. — open the project to retry.',
    link: `/projects/${PROJECTS.sourdoughClass.id}`,
    readAt: ago(4 * DAY),
    createdAt: ago(5 * DAY),
  },
];

const newestFirst = (a: DemoNotification, b: DemoNotification) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/** Lets other areas raise a notification (e.g. a generation finishing). */
export function addNotification(n: Omit<DemoNotification, 'readAt' | 'createdAt'>): void {
  if (rows.some((r) => r.id === n.id)) return;
  rows.push({ ...n, readAt: null, createdAt: new Date().toISOString() });
}

route('GET', '/notifications', ({ query }) => {
  const unread = query.get('unread');
  const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 20) || 20));
  const all = [...rows]
    .sort(newestFirst)
    .filter((n) => (unread === 'true' ? !n.readAt : unread === 'false' ? Boolean(n.readAt) : true));
  const cursor = query.get('cursor');
  const start = cursor ? all.findIndex((n) => n.id === cursor) + 1 : 0;
  const slice = all.slice(start, start + limit + 1);
  const hasMore = slice.length > limit;
  const data = hasMore ? slice.slice(0, limit) : slice;
  return {
    data,
    unreadCount: rows.filter((n) => !n.readAt).length,
    nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null,
    hasMore,
  };
});

route('POST', '/notifications/:id/read', ({ params }) => {
  const n = rows.find((r) => r.id === params.id);
  if (!n) throw new DemoHttpError(404, 'not_found', 'Notification not found');
  if (!n.readAt) n.readAt = new Date().toISOString();
  return { notification: { ...n } };
});

route('POST', '/notifications/read-all', () => {
  const now = new Date().toISOString();
  let updated = 0;
  for (const n of rows) {
    if (!n.readAt) {
      n.readAt = now;
      updated += 1;
    }
  }
  return { updated };
});
