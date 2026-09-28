'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { isUntitledName } from '../project-name';

// BACKLOG 17.9 — a project's name for display: the name the user gave it, or "Untitled video"
// in the reader's language (common.untitledVideo) when it has none (name null, or the English
// placeholder rows created before Phase 17 stored).

export function useProjectName(): (name: string | null | undefined) => string {
  const t = useTranslations('common');
  return useCallback(
    (name: string | null | undefined) =>
      isUntitledName(name) ? t('untitledVideo') : (name as string).trim(),
    [t],
  );
}
