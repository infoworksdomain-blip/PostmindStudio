// Demo stand-in for src/components/marketing/brand-src.ts (swapped in by scripts/demo/build.mjs):
// the single-file demo cannot load /brand/… from its host, so the logo and icon are bundled as
// data: URLs (esbuild loader 'dataurl'). The WebP lockups stand in for the PNG fallbacks.

import logoLight from '../../public/brand/logo-light.webp';
import logoDark from '../../public/brand/logo-dark.webp';
import icon from '../../public/brand/icon-64.png';

const url = (file: unknown): string => (typeof file === 'string' ? file : '');

export const BRAND_SRC = {
  logoLight: { webp: url(logoLight), png: url(logoLight) },
  logoDark: { webp: url(logoDark), png: url(logoDark) },
  icon: url(icon),
} as const;
