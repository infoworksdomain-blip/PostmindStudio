// In-browser stand-in for Better Auth's /api/auth/* in the demo build (Track A's sign-up, sign-in
// and verify-email screens call it directly). Nothing is created or signed in: sign-up and the
// resend link answer as the server would (200, then the "check your email" screen), sign-in lets
// the tour continue into the sample organisation, and everything else is refused with a code the
// screens map to their generic message.

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ANSWERS: Record<string, () => Response> = {
  'POST /sign-up/email': () => json(200, { token: null, user: null }),
  'POST /send-verification-email': () => json(200, { status: true }),
  'POST /sign-in/email': () => json(200, { redirect: false, token: null, user: null }),
  'POST /sign-out': () => json(200, { success: true }),
  'GET /get-session': () => json(200, null),
};

export async function handleAuth(url: URL, init?: RequestInit): Promise<Response> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = url.pathname.replace(/^\/api\/auth/, '');
  const answer = ANSWERS[`${method} ${path}`];
  if (answer) return answer();
  return json(403, { code: 'DEMO_ONLY', message: 'This sign-in step does not run in the demo.' });
}
