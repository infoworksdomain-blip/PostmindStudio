import { handleShotstackCallback } from '@/lib/studio/api/shotstack-callback';

// POST /api/studio/webhooks/shotstack — Shotstack render callbacks (BACKLOG 23.1). Public:
// authenticated by the per-render token in the query, not by a session; the render's status is
// always fetched from Shotstack before anything happens. See src/lib/studio/api/shotstack-callback.ts.
export async function POST(req: Request): Promise<Response> {
  return handleShotstackCallback(req);
}
