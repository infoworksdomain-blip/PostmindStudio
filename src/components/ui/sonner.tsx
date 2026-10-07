'use client';

import { useTheme } from 'next-themes';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import { cn } from '@/lib/utils';

// BACKLOG 25.3 — calm toasts: one surface for every tone (no neon "rich colours"); the tone is a
// small dot at the leading edge, so the message, not the colour, does the talking.

type ToastTone = 'success' | 'info' | 'warning' | 'error';

const DOT: Record<ToastTone, string> = {
  success: 'bg-success',
  info: 'bg-data',
  warning: 'bg-warning',
  error: 'bg-destructive',
};

function ToneDot({ tone }: { tone: ToastTone }) {
  return (
    <span
      aria-hidden
      data-slot="toast-dot"
      data-tone={tone}
      className={cn('block size-2 rounded-full', DOT[tone])}
    />
  );
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      icons={{
        success: <ToneDot tone="success" />,
        info: <ToneDot tone="info" />,
        warning: <ToneDot tone="warning" />,
        error: <ToneDot tone="error" />,
        loading: <Loader2Icon className="size-4 animate-spin text-muted-foreground" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius-field-size)',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'cn-toast gap-3! shadow-overlay! font-sans',
          title: 'font-medium',
          description: 'text-foreground-secondary!',
          icon: 'items-center justify-center',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
