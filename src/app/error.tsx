'use client';

import { PageErrorView } from '@/components/errors/page-error';

// 20.10 — an error thrown while rendering a public or sign-in page: a friendly, translated
// message with "Try again" instead of Next's "Application error: a client-side exception".

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-dvh items-center bg-background px-4 sm:px-8">
      <PageErrorView error={error} reset={reset} />
    </main>
  );
}
