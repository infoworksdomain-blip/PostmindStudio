'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { authApi, authErrorKey } from '@/lib/client/auth';
import { hardNavigate } from '@/lib/client/navigate';

// Phase 18 §2.9 — "Continue with Google". Better Auth builds the authorisation URL (state + PKCE
// kept server-side) and we follow it; the callback lands on /api/auth/callback/google. Shown only
// when GOOGLE_CLIENT_ID / _SECRET are set.

export function GoogleButton({ next }: { next: string }) {
  const t = useTranslations('auth');
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const { url } = await authApi.signInGoogle(next, '/sign-in?error=oauth');
      // Keep the spinner only while the page is really leaving (the demo stays put).
      if (url && hardNavigate(url)) return;
      setBusy(false);
    } catch (err) {
      toast.error(t(`errors.${authErrorKey(err)}`));
      setBusy(false);
    }
  };
  return (
    <>
      <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground uppercase">
        <span className="h-px flex-1 bg-border" />
        {t('google.or')}
        <span className="h-px flex-1 bg-border" />
      </div>
      <Button
        type="button"
        variant="outline"
        className="h-10 w-full"
        onClick={() => void start()}
        disabled={busy}
      >
        {busy && <Loader2 className="animate-spin" />}
        {t('google.continue')}
      </Button>
    </>
  );
}
