'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// BACKLOG 25.3 — the one "are you sure?". It stays open while the action runs and closes only
// when it resolves true; a false (or a throw) keeps it open so the caller's toast can explain.
// A destructive confirmation puts focus on Cancel, so a stray Enter never deletes anything.
// `useConfirm()` is the drop-in replacement for window.confirm in event handlers.

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Error tone on the confirm button and focus on Cancel. Default true. */
  destructive?: boolean;
  /** Resolve true to close the dialog; false keeps it open. A void return closes it. */
  onConfirm: () => Promise<boolean | void> | boolean | void;
  /** 25.12: fields the confirmation needs (a password, typing a name), between text and buttons. */
  children?: ReactNode;
  /** 25.12: keeps the confirm button disabled until those fields are filled in. */
  confirmDisabled?: boolean;
  /** 25.12: shows the confirm button busy while the caller's own request runs. */
  confirmLoading?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = true,
  onConfirm,
  children,
  confirmDisabled = false,
  confirmLoading = false,
}: ConfirmDialogProps) {
  const t = useTranslations('common.actions');
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function confirm() {
    setBusy(true);
    try {
      const done = await onConfirm();
      if (done !== false) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && !confirmLoading && onOpenChange(next)}>
      <DialogContent
        role="alertdialog"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          if (!destructive) return;
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader className="pe-0">
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{title}</DialogDescription>
          )}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="outline"
            disabled={busy || confirmLoading}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel ?? t('cancel')}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={confirmDisabled}
            loading={busy || confirmLoading}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
}

/**
 * Imperative confirmation: `const [confirm, dialog] = useConfirm();` render `dialog` once, then
 * `if (!(await confirm({ title, confirmLabel }))) return;` where window.confirm used to be.
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [request, setRequest] = useState<{
    options: ConfirmOptions;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setRequest({ options, resolve })),
    [],
  );

  const dialog = request ? (
    <ConfirmDialog
      open
      {...request.options}
      onOpenChange={(open) => {
        if (open) return;
        request.resolve(false);
        setRequest(null);
      }}
      onConfirm={() => {
        request.resolve(true);
        setRequest(null);
        return false;
      }}
    />
  ) : null;

  return [confirm, dialog];
}
