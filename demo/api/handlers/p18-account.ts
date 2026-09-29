// Phase 18 Track A sample handlers for /account/security: active sessions (no tokens; revoke one
// or all others) and account deletion (§5.11: re-authenticate with the password; the only owner
// of an organisation that has other members must transfer ownership first, 409 sole_owner).
// Nothing is deleted in the demo: a successful deletion signs out to the sign-in screen.
import { DemoHttpError, route } from '../registry';
import { setSignedIn } from '../session-state';
import { accountDeletionCheck } from './p18-org';
import { ago, DAY, HOUR } from './projects-store';

interface SessionRow {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

const sessions: SessionRow[] = [
  {
    id: 'sess-demo-current',
    createdAt: ago(2 * DAY),
    lastActiveAt: ago(60_000),
    ipAddress: '203.0.113.24',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    current: true,
  },
  {
    id: 'sess-demo-phone',
    createdAt: ago(9 * DAY),
    lastActiveAt: ago(5 * HOUR),
    ipAddress: '198.51.100.7',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
    current: false,
  },
];

route('GET', '/account/sessions', () => ({ sessions: sessions.map((s) => ({ ...s })) }));

route('DELETE', '/account/sessions', () => {
  const before = sessions.length;
  for (let i = sessions.length - 1; i >= 0; i--) if (!sessions[i]?.current) sessions.splice(i, 1);
  return { revoked: before - sessions.length };
});

route('DELETE', '/account/sessions/:id', ({ params }) => {
  const i = sessions.findIndex((s) => s.id === params.id && !s.current);
  if (i < 0) throw new DemoHttpError(404, 'not_found', 'Session not found');
  sessions.splice(i, 1);
  return { revoked: 1 };
});

route('POST', '/account/delete', ({ body }) => {
  accountDeletionCheck(body);
  // The account is signed out everywhere (the demo keeps the sample data; "Reset demo" restores).
  setSignedIn(false, { byUser: true });
  return { deleted: true, deleteAt: new Date(Date.now() + 30 * DAY).toISOString() };
});
