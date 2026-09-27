// Brand kits (services/brand-kits.ts): list (default first), create, update, set default,
// delete (refused while active projects use the kit, as the real service does).
import type { BrandKit } from '@/lib/client/types';
import { BRAND_KITS, DEMO_BUSINESS_ID, DEMO_ORG_ID } from '../ids';
import { DemoHttpError, route } from '../registry';

export type DemoBrandKit = BrandKit & {
  organisationId: string;
  businessProfileId: string | null;
  logoAssetId: string | null;
  watermarkAssetId: string | null;
  introCardAssetId: string | null;
  outroCardAssetId: string | null;
  voiceProfileId: string | null;
  createdAt: string;
  updatedAt: string;
};

const DAY = 86_400_000;
const LOADED_AT = Date.now();
const at = (ms: number) => new Date(LOADED_AT + ms).toISOString();

function kit(
  k: Omit<
    DemoBrandKit,
    | 'organisationId'
    | 'businessProfileId'
    | 'logoAssetId'
    | 'watermarkAssetId'
    | 'introCardAssetId'
    | 'outroCardAssetId'
    | 'voiceProfileId'
    | 'updatedAt'
  >,
): DemoBrandKit {
  return {
    organisationId: DEMO_ORG_ID,
    businessProfileId: 'bp-leeds-sourdough',
    logoAssetId: null,
    watermarkAssetId: null,
    introCardAssetId: null,
    outroCardAssetId: null,
    voiceProfileId: null,
    updatedAt: k.createdAt,
    ...k,
  };
}

const kits: DemoBrandKit[] = [
  kit({
    id: BRAND_KITS.main.id,
    businessId: DEMO_BUSINESS_ID,
    name: BRAND_KITS.main.name,
    isDefault: true,
    colourPalette: ['#1F1A17', '#E2552F', '#F3D9B1', '#FBF6EE', '#5C7A6B'],
    fontPrimary: 'Fraunces',
    fontSecondary: 'Inter',
    toneKeywords: ['warm', 'plain-spoken', 'craft-proud', 'cheeky'],
    audienceProfile:
      'Leeds locals 25–55 who care where their bread comes from: weekend brunchers, home bakers and independent café owners in north Leeds.',
    ctaTemplates: [
      { label: 'Visit', template: 'Come and see us on Harrogate Road — open from 7am.' },
      { label: 'Order', template: 'Pre-order for collection at leedssourdough.co.uk' },
      { label: 'Class', template: 'Book a Saturday sourdough class: link in bio.' },
    ],
    restrictedTopics: ['competitor bakeries', 'diet claims', 'gluten-free claims'],
    createdAt: at(-120 * DAY),
  }),
  kit({
    id: BRAND_KITS.seasonal.id,
    businessId: DEMO_BUSINESS_ID,
    name: BRAND_KITS.seasonal.name,
    isDefault: false,
    colourPalette: ['#7A1F2B', '#1E4D3A', '#F4E3C1', '#C9A227'],
    fontPrimary: 'Playfair Display',
    fontSecondary: 'Inter',
    toneKeywords: ['festive', 'generous', 'cosy'],
    audienceProfile: 'Gift buyers and families ordering stollen, mince pies and Christmas loaves.',
    ctaTemplates: [
      { label: 'Pre-order', template: 'Christmas pre-orders close 18 December — order online.' },
    ],
    restrictedTopics: ['competitor bakeries'],
    createdAt: at(-9 * DAY),
  }),
];

/** Active projects still using a kit (the real delete counts video_projects). */
const IN_USE: Record<string, number> = { [BRAND_KITS.main.id]: 4 };

const bad = (problems: string[]) =>
  new DemoHttpError(400, 'validation_error', 'Invalid request body', { problems });
const HEX = /^#[0-9a-fA-F]{6}$/;
const FONT = /^[A-Za-z0-9 -]{1,64}$/;

type KitFields = Partial<
  Pick<
    BrandKit,
    | 'name'
    | 'colourPalette'
    | 'fontPrimary'
    | 'fontSecondary'
    | 'toneKeywords'
    | 'audienceProfile'
    | 'ctaTemplates'
    | 'restrictedTopics'
  >
> & { voiceProfileId?: string | null };

const strings = (v: unknown, max: number, len: number) =>
  Array.isArray(v) &&
  v.length <= max &&
  v.every((s) => typeof s === 'string' && s.trim() && s.length <= len);

function parseFields(input: Record<string, unknown>, allowed: Set<string>): KitFields {
  const problems: string[] = [];
  const out: KitFields = {};
  for (const [key, v] of Object.entries(input)) {
    if (!allowed.has(key)) {
      problems.push(`Unrecognized key: "${key}"`);
      continue;
    }
    if (key === 'name') {
      if (typeof v !== 'string' || !v.trim() || v.length > 120)
        problems.push('name: must be 1–120 characters');
      else out.name = v.trim();
    } else if (key === 'colourPalette') {
      if (
        !Array.isArray(v) ||
        v.length > 8 ||
        !v.every((c) => typeof c === 'string' && HEX.test(c))
      )
        problems.push('colourPalette: colours must be #RRGGBB');
      else out.colourPalette = v as string[];
    } else if (key === 'fontPrimary' || key === 'fontSecondary') {
      if (v !== null && (typeof v !== 'string' || !FONT.test(v.trim())))
        problems.push(`${key}: invalid font name`);
      else out[key] = typeof v === 'string' ? v.trim() : null;
    } else if (key === 'toneKeywords') {
      if (!strings(v, 10, 40))
        problems.push('toneKeywords: at most 10 keywords of up to 40 characters');
      else out.toneKeywords = (v as string[]).map((s) => s.trim());
    } else if (key === 'restrictedTopics') {
      if (!strings(v, 30, 80))
        problems.push('restrictedTopics: at most 30 topics of up to 80 characters');
      else out.restrictedTopics = (v as string[]).map((s) => s.trim());
    } else if (key === 'audienceProfile') {
      if (v !== null && (typeof v !== 'string' || v.length > 1_000))
        problems.push('audienceProfile: at most 1000 characters');
      else out.audienceProfile = typeof v === 'string' ? v.trim() : null;
    } else if (key === 'voiceProfileId') {
      if (v !== null && (typeof v !== 'string' || !v.trim() || v.length > 64))
        problems.push('voiceProfileId: must be a voice profile id or null');
      else out.voiceProfileId = typeof v === 'string' ? v : null;
    } else if (key === 'ctaTemplates') {
      const ok =
        Array.isArray(v) &&
        v.length <= 10 &&
        v.every((c: unknown) => {
          const t = c as { label?: unknown; template?: unknown };
          return (
            typeof t?.label === 'string' &&
            t.label.trim() &&
            t.label.length <= 60 &&
            typeof t.template === 'string' &&
            t.template.trim() &&
            t.template.length <= 200
          );
        });
      if (!ok) problems.push('ctaTemplates: each needs a label (≤60) and template (≤200)');
      else
        out.ctaTemplates = (v as Array<{ label: string; template: string }>).map((c) => ({
          label: c.label.trim(),
          template: c.template.trim(),
        }));
    }
  }
  if (problems.length) throw bad(problems);
  return out;
}

const FIELDS = [
  'name',
  'colourPalette',
  'fontPrimary',
  'fontSecondary',
  'toneKeywords',
  'audienceProfile',
  'ctaTemplates',
  'restrictedTopics',
];

function find(id: string): DemoBrandKit {
  const k = kits.find((x) => x.id === id);
  if (!k) throw new DemoHttpError(404, 'not_found', 'Brand kit not found');
  return k;
}

const copy = (k: DemoBrandKit): DemoBrandKit => structuredClone(k);

/** Kits for other areas (e.g. the Create screen's brand kit picker). */
export function listBrandKits(businessId?: string): DemoBrandKit[] {
  return kits
    .filter((k) => !businessId || k.businessId === businessId)
    .sort(
      (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt),
    )
    .map(copy);
}

/** 13.13: a deleted voice profile leaves its kits on the stock voice; returns how many. */
export function unlinkVoiceProfile(voiceProfileId: string): number {
  const linked = kits.filter((k) => k.voiceProfileId === voiceProfileId);
  for (const k of linked) k.voiceProfileId = null;
  return linked.length;
}

route('GET', '/brand-kits', ({ query }) => ({
  data: listBrandKits(query.get('businessId') || undefined),
}));

route('GET', '/brand-kits/:id', ({ params }) => ({ brandKit: copy(find(params.id ?? '')) }));

route('POST', '/brand-kits', ({ body }) => {
  const input = (body ?? {}) as Record<string, unknown>;
  const { businessId, isDefault, ...rest } = input;
  if (typeof businessId !== 'string' || !businessId.trim())
    throw bad(['businessId: must be 1-128 characters']);
  if (typeof rest.name !== 'string') throw bad(['name: Invalid input: expected string']);
  const fields = parseFields(rest, new Set(FIELDS));
  const first = !kits.some((k) => k.businessId === businessId);
  const makeDefault = isDefault === true || first;
  if (makeDefault) for (const k of kits) if (k.businessId === businessId) k.isDefault = false;
  const now = new Date().toISOString();
  const created = kit({
    id: `bk-${Date.now().toString(36)}`,
    businessId,
    name: fields.name ?? rest.name,
    isDefault: makeDefault,
    colourPalette: fields.colourPalette ?? [],
    fontPrimary: fields.fontPrimary ?? null,
    fontSecondary: fields.fontSecondary ?? null,
    toneKeywords: fields.toneKeywords ?? [],
    audienceProfile: fields.audienceProfile ?? null,
    ctaTemplates: fields.ctaTemplates ?? [],
    restrictedTopics: fields.restrictedTopics ?? [],
    createdAt: now,
  });
  kits.push(created);
  return { status: 201, body: { brandKit: copy(created) } };
});

route('PATCH', '/brand-kits/:id', ({ params, body }) => {
  const current = find(params.id ?? '');
  const fields = parseFields(
    (body ?? {}) as Record<string, unknown>,
    new Set([...FIELDS, 'voiceProfileId']),
  );
  if (Object.keys(fields).length === 0) throw bad(['Nothing to update']);
  Object.assign(current, fields, { updatedAt: new Date().toISOString() });
  return { brandKit: copy(current) };
});

route('POST', '/brand-kits/:id/set-default', ({ params }) => {
  const target = find(params.id ?? '');
  for (const k of kits) if (k.businessId === target.businessId) k.isDefault = k.id === target.id;
  target.updatedAt = new Date().toISOString();
  return { brandKit: copy(target) };
});

route('DELETE', '/brand-kits/:id', ({ params }) => {
  const target = find(params.id ?? '');
  const inUse = IN_USE[target.id] ?? 0;
  if (inUse > 0)
    throw new DemoHttpError(
      400,
      'validation_error',
      `Brand kit is used by ${inUse} active project(s)`,
    );
  kits.splice(kits.indexOf(target), 1);
  return { deleted: true };
});
