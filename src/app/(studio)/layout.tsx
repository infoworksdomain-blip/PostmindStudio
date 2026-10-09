import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/studio/app-shell';
import { NOINDEX } from '@/lib/seo/page-metadata';

// 26.2: the signed-in app is never indexed (robots.txt also keeps crawlers out of these paths).
export const metadata: Metadata = { robots: NOINDEX };

export default function StudioLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
