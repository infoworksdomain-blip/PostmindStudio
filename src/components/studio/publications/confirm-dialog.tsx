'use client';

import { useTranslations } from 'next-intl';
import {
  ConfirmDialog as BaseConfirmDialog,
  type ConfirmDialogProps,
} from '@/components/ui/confirm-dialog';

// 25.3: a thin shim over the one ConfirmDialog (src/components/ui/confirm-dialog.tsx) that keeps
// this family's "Keep it" cancel wording for take down, cancel, disconnect and delete.

export function ConfirmDialog({ cancelLabel, ...props }: ConfirmDialogProps) {
  const t = useTranslations('publications.confirmDialog');
  return <BaseConfirmDialog {...props} cancelLabel={cancelLabel ?? t('keep')} />;
}
