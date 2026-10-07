// BACKLOG 25.3 — the one look for every text field, textarea and native select: a 1px `input`
// edge (≥3:1, WCAG 1.4.11), the field radius, a raised wash on hover in the darkroom and the
// 2px signal focus ring. Shared so Input, Textarea and NativeSelect never drift apart.
export const fieldBase =
  'w-full min-w-0 rounded-field border border-input bg-background text-base text-foreground transition-[border-color,box-shadow,background-color] duration-(--duration-fast) ease-standard outline-none placeholder:text-muted-foreground hover:border-[color-mix(in_oklch,var(--input),var(--foreground)_20%)] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:bg-surface-raised disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/25 md:text-sm dark:bg-surface';
