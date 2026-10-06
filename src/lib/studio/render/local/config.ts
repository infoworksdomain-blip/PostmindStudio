import { ConfigurationError } from '../../../errors';

// BACKLOG 23.5 — STUDIO_LOCAL_RENDER=on|off (default on): slideshows and walls of text are
// rendered by Studio's own ffmpeg renderer (render/local) when ffmpeg is installed, with Shotstack
// as the fallback; `off` sends every render to Shotstack as before. Shotstack still renders AI
// video, UGC, hook + demo and uploads (the source types not listed here).

export const LOCAL_RENDER_ENV = 'STUDIO_LOCAL_RENDER';

/** Project source types the local renderer makes (spec: the cheap formats). */
export const LOCAL_RENDER_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'SLIDESHOW',
  'WALL_OF_TEXT',
]);

export function localRenderEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[LOCAL_RENDER_ENV]?.trim().toLowerCase();
  if (!raw || raw === 'on') return true;
  if (raw === 'off') return false;
  throw new ConfigurationError(`${LOCAL_RENDER_ENV} must be on or off`);
}
