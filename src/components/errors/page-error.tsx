'use client';

import Link from 'next/link';
import { AlertTriangle, Compass, RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

// 20.10 — what a user sees instead of Next's bare defaults: "404 This page could not be found."
// (English only, unstyled) and "Application error: a client-side exception has occurred" (a blank
// page with one line). Used by src/app/not-found.tsx, src/app/error.tsx and
// src/app/(studio)/error.tsx (the last keeps the app shell around the message).

function Panel({
  icon,
  title,
  body,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </span>
      <h1 className="font-display text-3xl leading-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
      <div className="flex flex-wrap justify-center gap-2">{children}</div>
    </div>
  );
}

export function NotFoundView() {
  const t = useTranslations('errorPage.notFound');
  return (
    <Panel icon={<Compass className="size-6" aria-hidden />} title={t('title')} body={t('body')}>
      <Button asChild>
        <Link href="/projects">{t('projects')}</Link>
      </Button>
      <Button asChild variant="outline">
        <Link href="/">{t('home')}</Link>
      </Button>
    </Panel>
  );
}

export function PageErrorView({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errorPage.boundary');
  return (
    <div role="alert">
      <Panel
        icon={<AlertTriangle className="size-6" aria-hidden />}
        title={t('title')}
        body={t('body')}
      >
        <Button onClick={reset}>
          <RotateCw aria-hidden /> {t('retry')}
        </Button>
        <Button asChild variant="outline">
          <Link href="/projects">{t('projects')}</Link>
        </Button>
      </Panel>
      {error.digest && (
        <p className="-mt-10 text-center text-xs text-muted-foreground">
          {t('reference', { digest: error.digest })}
        </p>
      )}
    </div>
  );
}
