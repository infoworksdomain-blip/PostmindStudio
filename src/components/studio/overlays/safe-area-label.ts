'use client';

import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import type { SafeArea } from './safe-areas';

// BACKLOG 16.3 — a safe-area guide's caption in the interface language (overlays.safeArea.*).

export function useSafeAreaLabel(): (area: SafeArea) => string {
  const t = useTranslations('overlays.safeArea');
  const f = useFormat();
  return (area) =>
    area.labelKey === 'titleSafe'
      ? t('titleSafe', { platform: f.platform(area.platform) })
      : t(area.labelKey);
}
