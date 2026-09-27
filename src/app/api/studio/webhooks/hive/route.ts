import { handleHiveWebhook } from '@/lib/studio/api/hive-webhook';

// POST /api/studio/webhooks/hive?token=… — Hive async moderation callback (BACKLOG 13.25).
// Authenticated by the per-task callback token, not by JWT (see src/lib/studio/api/hive-webhook.ts).
export async function POST(req: Request): Promise<Response> {
  return handleHiveWebhook(req);
}
