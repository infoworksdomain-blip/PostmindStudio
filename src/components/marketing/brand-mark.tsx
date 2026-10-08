import { cn } from '@/lib/utils';

// 25.5 — the PostMind mark: an ink rounded square with the vermilion record dot. The same drawing
// is the favicon (src/app/icon.svg), the apple-touch icon and the link-preview image's mark.

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden
      focusable="false"
      className={cn('size-7 shrink-0', className)}
    >
      <rect width="32" height="32" rx="8" className="fill-foreground" />
      <circle cx="16" cy="16" r="6" fill="oklch(0.62 0.2 33)" />
    </svg>
  );
}
