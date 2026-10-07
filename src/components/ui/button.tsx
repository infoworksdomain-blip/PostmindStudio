import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Slot } from 'radix-ui';

// BACKLOG 25.3 — one button for every job. Variants by intent, not by colour:
//   primary (alias `default`) — the one main action on a surface; brand signal fill.
//   secondary — a quiet raised wash for supporting actions.
//   tertiary (alias `outline`) — a hairline edge on the canvas, for third-rank actions.
//   ghost — no chrome until hovered: toolbars, rows, icon buttons.
//   destructive — irreversible actions, error tone on a soft wash.
//   link — inline text action.
// Every state is designed: hover (a step towards ink), pressed (one more step plus a 1px
// settle), a visible 2px signal focus ring with an offset, and a disabled state that keeps
// the label legible. `loading` swaps in a spinner, sets aria-busy and blocks clicks.

const buttonVariants = cva(
  [
    'group/button relative inline-flex shrink-0 items-center justify-center rounded-control border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap select-none',
    'transition-[color,background-color,border-color,box-shadow,transform] duration-(--duration-fast) ease-standard',
    'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'active:not-aria-[haspopup]:translate-y-px',
    'disabled:pointer-events-none disabled:opacity-45 aria-busy:cursor-progress',
    'aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/30',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ].join(' '),
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-raised hover:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_10%)] active:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_18%)]',
        primary:
          'bg-primary text-primary-foreground shadow-raised hover:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_10%)] active:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_18%)]',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-surface-active active:bg-[color-mix(in_oklch,var(--surface-active),var(--foreground)_6%)] aria-expanded:bg-surface-active',
        outline:
          'border-border-strong bg-transparent text-foreground hover:bg-surface-raised active:bg-surface-active aria-expanded:bg-surface-raised',
        tertiary:
          'border-border-strong bg-transparent text-foreground hover:bg-surface-raised active:bg-surface-active aria-expanded:bg-surface-raised',
        ghost:
          'text-foreground-secondary hover:bg-surface-raised hover:text-foreground active:bg-surface-active aria-expanded:bg-surface-raised aria-expanded:text-foreground',
        destructive:
          'bg-destructive-soft text-destructive-foreground hover:bg-[color-mix(in_oklch,var(--destructive-soft),var(--destructive)_14%)] active:bg-[color-mix(in_oklch,var(--destructive-soft),var(--destructive)_24%)] focus-visible:ring-destructive',
        link: 'h-auto! px-0! text-primary underline-offset-4 hover:underline active:translate-y-0',
      },
      size: {
        default:
          'h-9 gap-1.5 px-3.5 has-data-[icon=inline-end]:pe-3 has-data-[icon=inline-start]:ps-3',
        xs: "h-6 gap-1 px-2 text-xs has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3 text-[0.8125rem] has-data-[icon=inline-end]:pe-2.5 has-data-[icon=inline-start]:ps-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-10 gap-2 px-4.5 text-[0.9375rem] has-data-[icon=inline-end]:pe-4 has-data-[icon=inline-start]:ps-4',
        icon: 'size-9',
        'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': "size-8 [&_svg:not([class*='size-'])]:size-3.5",
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** Shows a spinner, sets aria-busy and disables the button while true. */
    loading?: boolean;
  };

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  const isIconOnly = typeof size === 'string' && size.startsWith('icon');

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      aria-busy={loading || undefined}
      disabled={asChild ? disabled : disabled || loading}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {loading && !asChild ? (
        <>
          <Loader2 aria-hidden data-slot="button-spinner" className="animate-spin" />
          {isIconOnly ? null : children}
        </>
      ) : (
        children
      )}
    </Comp>
  );
}

export { Button, buttonVariants, type ButtonProps };
