'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { FeedbackDialog } from '@/components/studio/feedback-dialog';
import { APP_HOME } from '@/lib/auth/page-guard';

// 20.10 — what a user sees instead of Next's bare defaults: "404 This page could not be found."
// (English only, unstyled) and "Application error: a client-side exception has occurred" (a blank
// page with one line). Used by src/app/not-found.tsx, src/app/error.tsx and
// src/app/(studio)/error.tsx (the last keeps the app shell around the message).
// 25.6: a typographic composition (no illustration): a quiet mono label, the H1, what happened
// and what to do, one primary action and a quiet secondary. Signed in, "home" is /home; signed
// out (or unknown) it is "/", which itself sends a signed-in visitor on to /home.

function Panel({
  label,
  title,
  body,
  actions,
  after,
}: {
  label: string;
  title: string;
  body: string;
  actions: ReactNode;
  after?: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col py-16 sm:py-24">
      <p className="font-mono text-xs text-foreground-secondary">{label}</p>
      <h1 className="mt-3 font-display text-[2rem] leading-[1.1] text-balance sm:text-[2.5rem]">
        {title}
      </h1>
      <p className="mt-4 text-[0.9375rem] leading-relaxed text-foreground-secondary">{body}</p>
      <div className="mt-8 flex flex-wrap items-center gap-3">{actions}</div>
      {after}
    </div>
  );
}

export function NotFoundView({ signedIn = false }: { signedIn?: boolean }) {
  const t = useTranslations('errorPage.notFound');
  return (
    <Panel
      label={t('label')}
      title={t('title')}
      body={t('body')}
      actions={
        signedIn ? (
          <>
            <Button asChild size="lg">
              <Link href={APP_HOME}>{t('goHome')}</Link>
            </Button>
            <Button asChild size="lg" variant="ghost">
              <Link href="/projects">{t('projects')}</Link>
            </Button>
          </>
        ) : (
          <>
            <Button asChild size="lg">
              <Link href="/">{t('home')}</Link>
            </Button>
            <Button asChild size="lg" variant="ghost">
              <Link href="/sign-in">{t('signIn')}</Link>
            </Button>
          </>
        )
      }
    />
  );
}

export function PageErrorView({
  error,
  reset,
  signedIn = false,
  feedback = false,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** Inside the app shell: home is /home. */
  signedIn?: boolean;
  /** Offer "Tell us what happened" (the shell's feedback dialog; it needs a session). */
  feedback?: boolean;
}) {
  const t = useTranslations('errorPage.boundary');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  return (
    <div role="alert">
      <Panel
        label={t('label')}
        title={t('title')}
        body={t('body')}
        actions={
          <>
            <Button size="lg" onClick={reset}>
              <RotateCw aria-hidden /> {t('retry')}
            </Button>
            <Button asChild size="lg" variant="ghost">
              <Link href={signedIn ? APP_HOME : '/'}>{signedIn ? t('goHome') : t('home')}</Link>
            </Button>
            {feedback && (
              <Button
                size="lg"
                variant="link"
                className="text-foreground-secondary hover:text-foreground"
                onClick={() => setFeedbackOpen(true)}
              >
                {t('feedback')}
              </Button>
            )}
          </>
        }
        after={
          error.digest ? (
            <p className="mt-10 border-t border-border pt-4 font-mono text-xs text-foreground-secondary">
              {t('reference', { digest: error.digest })}
            </p>
          ) : undefined
        }
      />
      {feedback && <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />}
    </div>
  );
}
