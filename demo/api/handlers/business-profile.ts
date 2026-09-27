// Business profile (services/scans.ts getBusinessProfile / patchBusinessProfile): what Studio's
// classifier made of the Leeds Sourdough website, editable by the user.
import type { BusinessProfile, ProfileListField } from '@/components/studio/business/types';
import { DEMO_BUSINESS_ID, DEMO_ORG_ID } from '../ids';
import { DemoHttpError, route } from '../registry';

type StoredProfile = BusinessProfile & { organisationId: string; classifierVersion: number };

const profiles = new Map<string, StoredProfile>([
  [
    DEMO_BUSINESS_ID,
    {
      id: 'bp-leeds-sourdough',
      organisationId: DEMO_ORG_ID,
      businessId: DEMO_BUSINESS_ID,
      industry: 'Food & drink',
      subNiche: 'Artisan sourdough bakery and café',
      products: [
        'Country sourdough',
        'Seeded rye',
        'Focaccia',
        'Butter croissants',
        'Cardamom buns',
        'Pastel de nata',
        'Celebration cakes',
        'Christmas stollen',
      ],
      services: [
        'Saturday sourdough classes',
        'Wholesale bread for cafés',
        'Celebration cake orders',
        'Click & collect',
      ],
      audienceKeywords: [
        'Leeds foodies',
        'Chapel Allerton locals',
        'weekend brunchers',
        'home bakers',
        'independent café owners',
        'gift buyers',
      ],
      toneIndicators: ['warm', 'down-to-earth', 'craft-proud', 'a little cheeky'],
      regions: ['Leeds', 'West Yorkshire'],
      imageThemes: [
        'crusty loaves in morning light',
        'hands shaping dough',
        'busy counter on a Saturday',
        'flour-dusted bench',
        'seasonal bakes',
      ],
      imageSearchQueries: [
        'artisan sourdough bread',
        'bakery counter morning',
        'baker hands dough',
        'croissant close up',
        'cosy cafe coffee',
      ],
      restrictedTopics: ['competitor bakeries', 'diet or weight-loss claims', 'gluten-free claims'],
      brandVoiceSummary:
        'A neighbourhood bakery that takes bread seriously and itself less so: warm, plain-spoken Yorkshire English, proud of long ferments and early starts, never salesy. Short sentences, a wink of humour, always an invitation to come in.',
      classifierModel: 'claude-sonnet-5',
      classifierVersion: 1,
      lastRefreshedAt: new Date(Date.now() - 21 * 86_400_000).toISOString(),
      editedByUser: false,
    },
  ],
]);

const LIST_FIELDS: ProfileListField[] = [
  'products',
  'services',
  'audienceKeywords',
  'toneIndicators',
  'regions',
  'imageThemes',
  'imageSearchQueries',
  'restrictedTopics',
];
const LIST_MAX: Record<ProfileListField, number> = {
  products: 30,
  services: 30,
  audienceKeywords: 20,
  toneIndicators: 10,
  regions: 10,
  imageThemes: 20,
  imageSearchQueries: 10,
  restrictedTopics: 20,
};

export function getProfile(businessId: string): BusinessProfile | undefined {
  const p = profiles.get(businessId);
  return p && structuredClone(p);
}

/** A finished scan refreshes the classification unless the user has edited it (A6.8). */
export function refreshProfileFromScan(businessId: string, at: string): void {
  const p = profiles.get(businessId);
  if (!p) return;
  profiles.set(
    businessId,
    p.editedByUser ? p : { ...p, lastRefreshedAt: at, classifierVersion: p.classifierVersion + 1 },
  );
}

const bad = (message: string, problems?: string[]) =>
  new DemoHttpError(400, 'validation_error', message, problems ? { problems } : undefined);

function parsePatch(body: unknown): Partial<BusinessProfile> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Invalid request body');
  const input = body as Record<string, unknown>;
  const out: Partial<BusinessProfile> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (key === 'industry' || key === 'subNiche') {
      if (typeof value !== 'string' || !value.trim() || value.length > 200)
        problems.push(`${key}: must be 1–200 characters`);
      else out[key] = value.trim();
    } else if (key === 'brandVoiceSummary') {
      if (value !== null && (typeof value !== 'string' || value.length > 1_000))
        problems.push(`${key}: at most 1000 characters`);
      else out.brandVoiceSummary = typeof value === 'string' ? value.trim() : null;
    } else if ((LIST_FIELDS as string[]).includes(key)) {
      const field = key as ProfileListField;
      if (
        !Array.isArray(value) ||
        value.some((v) => typeof v !== 'string' || !v.trim() || v.length > 120)
      )
        problems.push(`${key}: expected a list of 1–120 character items`);
      else if (value.length > LIST_MAX[field])
        problems.push(`${key}: at most ${LIST_MAX[field]} items`);
      else out[field] = [...new Set((value as string[]).map((v) => v.trim()))];
    } else {
      problems.push(`Unrecognized key: "${key}"`);
    }
  }
  if (problems.length) throw bad('Invalid request body', problems);
  if (Object.keys(out).length === 0) throw bad('Invalid request body', ['Nothing to update']);
  return out;
}

function find(businessId: string): StoredProfile {
  const p = profiles.get(businessId);
  if (!p)
    throw new DemoHttpError(404, 'not_found', 'No business profile yet: run a website scan first');
  return p;
}

route('GET', '/businesses/:id/business-profile', ({ params }) => ({
  profile: structuredClone(find(params.id ?? '')),
}));

route('PATCH', '/businesses/:id/business-profile', ({ params, body }) => {
  const current = find(params.id ?? '');
  const patch = parsePatch(body);
  if (patch.imageSearchQueries && patch.imageSearchQueries.length === 0)
    throw bad('imageSearchQueries needs at least one query');
  const next = { ...current, ...patch, editedByUser: true };
  profiles.set(current.businessId, next);
  return { profile: structuredClone(next) };
});
