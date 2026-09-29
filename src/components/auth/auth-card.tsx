'use client';

import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { authErrorKey } from '@/lib/client/auth';

// Phase 18 Track A — the frame every sign-in screen shares: brand line, a display-serif title in
// the Studio editorial style, the form, and a footer of links.

export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useTranslations('auth.shell');
  return (
    <div className="w-full max-w-md">
      <p className="mb-6 text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
        {t('brand')}
      </p>
      <div className="rounded-2xl bg-card p-8 shadow-sm ring-1 ring-foreground/10">
        <h1 className="font-display text-4xl leading-none">{title}</h1>
        {description && <p className="mt-3 text-sm text-muted-foreground">{description}</p>}
        <div className="mt-8">{children}</div>
      </div>
      {footer && (
        <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  );
}

/** The translated message for an auth error (never the server's raw text). */
export function AuthError({ error }: { error: unknown }) {
  const t = useTranslations('auth.errors');
  if (!error) return null;
  return (
    <Alert variant="destructive" className="mb-4">
      <AlertCircle />
      <AlertDescription>
        {t(typeof error === 'string' ? 'generic' : authErrorKey(error))}
      </AlertDescription>
    </Alert>
  );
}

export function AuthNotice({ children }: { children: ReactNode }) {
  return (
    <Alert className="mb-4">
      <CheckCircle2 />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/**
 * Track B §2.8: mail to a suppressed (bounced / complained) address is never sent. The server
 * cannot say so without revealing whether an account exists, so every "check your inbox" screen
 * carries the support contact (when STUDIO_SUPPORT_EMAIL is set).
 */
export function SupportContact({ email }: { email?: string }) {
  const t = useTranslations('auth.support');
  if (!email) return null;
  return (
    <p className="mt-6 text-xs text-muted-foreground">
      {t.rich('noEmail', {
        email,
        link: (chunks) => (
          <a className="underline underline-offset-4" href={`mailto:${email}`} dir="ltr">
            {chunks}
          </a>
        ),
      })}
    </p>
  );
}
