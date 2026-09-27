// GET /api/health — liveness only (process is up); no dependencies checked (Engagement 14.14).
// Readiness with DB/Redis checks arrives with observability (BACKLOG 11.7).
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ ok: true, service: 'postmind-studio' });
}
