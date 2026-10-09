import { cn } from '@/lib/utils';
import { BRAND_SRC } from './brand-src';

// 26.2 — the PostMind Studio artwork (public/brand/, built from assets/brand/ by
// scripts/brand/build-brand-assets.mjs). BrandLogo is the lockup (film-strip play icon, "PostMind",
// "STUDIO"): dark text in the light theme, near-white text under `.dark`; both are in the markup and
// CSS shows one, so there is no flash when the theme script runs. The pair carries one accessible
// name on its wrapper. BrandIcon is the icon alone, for places only a mark fits.

export const BRAND_NAME = 'PostMind Studio';

/** The lockup's intrinsic aspect (assets are 241×80 for 2× at 40 px tall). */
const LOGO = { width: 120, height: 40 } as const;

function LogoPicture({
  variant,
  eager,
  className,
}: {
  variant: 'light' | 'dark';
  eager: boolean;
  className: string;
}) {
  const src = variant === 'light' ? BRAND_SRC.logoLight : BRAND_SRC.logoDark;
  return (
    <picture className={className}>
      <source type="image/webp" srcSet={src.webp} />
      <img
        src={src.png}
        alt=""
        width={LOGO.width}
        height={LOGO.height}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        className="block h-full w-auto"
        data-brand-logo={variant}
      />
    </picture>
  );
}

export function BrandLogo({
  className,
  eager = false,
  label = BRAND_NAME,
}: {
  /** Sets the height (default h-10, 40 px); the width follows the artwork. */
  className?: string;
  /** Header logos load eagerly; footers and panels lazily. */
  eager?: boolean;
  /** The accessible name; pass null inside a link that already names it. */
  label?: string | null;
}) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      className={cn('inline-flex h-10 shrink-0', className)}
    >
      <LogoPicture variant="light" eager={eager} className="h-full dark:hidden" />
      <LogoPicture variant="dark" eager={eager} className="hidden h-full dark:block" />
    </span>
  );
}

export function BrandIcon({
  className,
  label = BRAND_NAME,
  eager = false,
}: {
  /** Sets the size (default size-7, 28 px). */
  className?: string;
  label?: string | null;
  eager?: boolean;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a 3 KB static PNG; no optimiser needed
    <img
      src={BRAND_SRC.icon}
      alt={label ?? ''}
      aria-hidden={label ? undefined : true}
      width={28}
      height={28}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      className={cn('size-7 shrink-0', className)}
    />
  );
}
