// BACKLOG 20.7 — where the render fonts are fetched from. Shotstack has no system fonts and the
// FFmpeg pre-renderer / thumbnail composer download their font too, so every family Studio names
// in a render is fetched as <fontsBaseUrl>/<FamilyNoSpaces>.ttf (overlays/shotstack.ts
// fontSources, pipeline/brand-resolve.ts hostedFontUrl, overlays/prerender.ts).
//
// Studio ships those files itself in public/fonts/ (licences and sources: public/fonts/SOURCES.md),
// and Next.js serves public/ from the site root, so by default the base URL is APP_URL + /fonts.
// STUDIO_FONTS_BASE_URL still overrides it (a CDN, or a host with more families). Uploaded brand
// fonts are signed storage URLs and do not go through this.

/** Path under APP_URL where public/fonts/ is served. */
export const SELF_HOSTED_FONTS_PATH = '/fonts';

/** File name of a family on the fonts host: spaces removed, e.g. "Noto Sans SC" → NotoSansSC.ttf. */
export function hostedFontFileName(family: string): string {
  return `${family.replace(/ /g, '')}.ttf`;
}

/**
 * The fonts base URL: STUDIO_FONTS_BASE_URL when set, else APP_URL + /fonts (the fonts this app
 * serves from public/fonts/), else undefined (text overlays then fail with a configuration error).
 */
export function fontsBaseUrlFromEnv(env: Record<string, string | undefined>): string | undefined {
  const explicit = env.STUDIO_FONTS_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const appUrl = env.APP_URL?.trim().replace(/\/+$/, '');
  return appUrl ? `${appUrl}${SELF_HOSTED_FONTS_PATH}` : undefined;
}
