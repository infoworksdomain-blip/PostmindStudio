import { cn } from '@/lib/utils';

// BACKLOG 25.3 — a quiet shimmer: a lighter band sweeps across a raised wash. Under
// prefers-reduced-motion the sweep is removed and the block simply holds still.
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      // A skeleton that carries a label is a loading announcement; aria-label needs a role.
      role={props['aria-label'] ? 'status' : undefined}
      className={cn(
        'relative isolate overflow-hidden rounded-control bg-surface-raised',
        'before:absolute before:inset-0 before:animate-shimmer before:bg-linear-to-r before:from-transparent before:via-surface-active before:to-transparent motion-reduce:before:hidden',
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
