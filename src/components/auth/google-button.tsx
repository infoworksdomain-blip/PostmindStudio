'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { authApi, authErrorKey } from '@/lib/client/auth';
import { hardNavigate } from '@/lib/client/navigate';

// Phase 18 §2.9 — "Continue with Google". Better Auth builds the authorisation URL (state + PKCE
// kept server-side) and we follow it; the callback lands on /api/auth/callback/google. Shown only
// when GOOGLE_CLIENT_ID / _SECRET are set.
// 25.6: per Google's sign-in branding, a neutral (white in daylight, dark surface in the darkroom)
// button with a hairline edge and the standard "Continue with Google" label. The official G mark
// is not in the repo, so the button stays text-only rather than drawing an imitation.

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
      <div className="my-6 flex items-center gap-3 text-xs text-foreground-secondary">
        <span aria-hidden className="h-px flex-1 bg-border" />
        {t('google.or')}
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="w-full bg-card font-medium text-foreground hover:bg-surface-raised"
        onClick={() => void start()}
        loading={busy}
      >
        {t('google.continue')}
      </Button>
    </>
  );
}
