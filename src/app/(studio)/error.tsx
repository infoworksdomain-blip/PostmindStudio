'use client';

import { PageErrorView } from '@/components/errors/page-error';

// 20.10 — an error thrown while rendering a Studio page: the message appears inside the app
// shell (sidebar and header stay), so the user can retry or go elsewhere.

export default function StudioError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageErrorView error={error} reset={reset} />;
}
