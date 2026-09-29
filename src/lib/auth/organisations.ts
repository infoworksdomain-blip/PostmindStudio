import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ValidationError } from '../errors';
import { LOCALES } from '../i18n/locales';

// Phase 18 §3 onboarding step 1: create an organisation (the caller becomes its owner and it
// becomes the session's active organisation).

export const createOrganisationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** ISO 3166-1 alpha-2, for tax. */
  country: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/)),
  defaultLocale: z.enum(LOCALES),
});

export type CreateOrganisationInput = z.infer<typeof createOrganisationSchema>;

/** A URL-safe, unique-enough slug: the name's ASCII letters/digits plus 6 random hex chars. */
export function organisationSlug(
  name: string,
  random: () => string = () => randomBytes(3).toString('hex'),
): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'org'}-${random()}`;
}

export async function parseCreateOrganisation(req: Request): Promise<CreateOrganisationInput> {
  let json: unknown;
  try {
    json = JSON.parse((await req.text()) || '{}');
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
  const parsed = createOrganisationSchema.safeParse(json);
  if (!parsed.success) {
    throw new ValidationError('Request body failed validation', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}
