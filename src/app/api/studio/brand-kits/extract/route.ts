import { ValidationError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { fileField, readMultipart } from '@/lib/studio/api/multipart';
import { withStudioRoute } from '@/lib/studio/api/route';
import { extractPalette, MAX_LOGO_BYTES } from '@/lib/studio/images/palette';

// POST /api/studio/brand-kits/extract (multipart: logo) — suggested palette from a logo
// (spec 14.5 "upload logo and auto-extract", BACKLOG 13.14). Nothing is stored. suggestedFont is
// always null: a font cannot be identified reliably from a raster logo.
export const POST = withStudioRoute(StudioCapability.ProjectWrite, async ({ req }) => {
  const form = await readMultipart(req, MAX_LOGO_BYTES + 64 * 1024);
  const logo = fileField(form, 'logo');
  if (!logo) throw new ValidationError('logo is required');
  const palette = await extractPalette(new Uint8Array(await logo.arrayBuffer()));
  return { body: { palette, suggestedFont: null } };
});
