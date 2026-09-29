import { handleUnsubscribe } from '@/lib/email/routes';

// GET|POST /api/email/unsubscribe?token=… — one-click unsubscribe from a notification kind
// (Phase 18 §2.8, RFC 8058). Public: the HMAC token is the authorisation. GET shows a confirm
// page and changes nothing; POST (the page's button, or a mail client's one-click) applies it.
export async function GET(req: Request): Promise<Response> {
  return handleUnsubscribe(req);
}

export async function POST(req: Request): Promise<Response> {
  return handleUnsubscribe(req);
}
