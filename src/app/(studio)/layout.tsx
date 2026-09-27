import type { ReactNode } from 'react';
import { AppShell } from '@/components/studio/app-shell';

export default function StudioLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
