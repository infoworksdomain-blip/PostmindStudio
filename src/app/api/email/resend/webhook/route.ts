import { handleResendWebhook } from '@/lib/email/routes';

// POST /api/email/resend/webhook — Resend delivery events (Phase 18 §2.8). Public: authenticated
// by the Svix signature (RESEND_WEBHOOK_SECRET), not by a session. See src/lib/email/webhook.ts.
export async function POST(req: Request): Promise<Response> {
  return handleResendWebhook(req);
}
