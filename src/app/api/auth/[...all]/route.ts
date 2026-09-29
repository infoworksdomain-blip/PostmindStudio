import { NextResponse } from 'next/server';
import { studioModes } from '@/lib/mode';

// Phase 18 §2.1: Better Auth's endpoints (sign-up, sign-in, verify, reset, 2FA, organisations,
// sessions) at /api/auth/*, mounted per https://www.better-auth.com/docs/integrations/next
// ("Create API Route", read 2026-09-29). Core mode has no local sign-in: every path is 404.

export const dynamic = 'force-dynamic';

async function handle(req: Request): Promise<Response> {
  if (studioModes().identity !== 'standalone') {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  const { getAuth } = await import('@/lib/auth/server');
  return (await getAuth()).handler(req);
}

export const GET = handle;
export const POST = handle;
