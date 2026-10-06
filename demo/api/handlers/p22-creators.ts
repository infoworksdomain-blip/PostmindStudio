// Phase 22.3 demo handlers: reusable AI creators of the sample business (two seeded creators,
// create / regenerate / rename / make default / retire, and the Create → UGC picker). Shapes
// match src/app/api/studio/businesses/[id]/creators/** and services/creators.ts presentCreator.
// Portraits are illustrated SVG placeholders marked SAMPLE (no image generation in the demo).
import { DEMO_BUSINESS_ID } from '../ids';
import { DemoHttpError, route } from '../registry';

type Status = 'DRAFT' | 'READY' | 'RETIRED';

interface DemoCreator {
  id: string;
  businessId: string;
  name: string;
  gender: 'woman' | 'man';
  ageRange: '18-24' | '25-34' | '35-44' | '45-60';
  setting: 'kitchen' | 'living_room' | 'car' | 'outdoors' | 'bathroom' | 'desk' | 'shop';
  appearance: string | null;
  voiceTone: string | null;
  status: Status;
  isDefault: boolean;
  useCount: number;
  lastUsedAt: string | null;
  portraitError: string | null;
  portraitSource: 'GENERATED' | 'UPLOAD' | null;
  portraitUrl: string | null;
  createdAt: string;
  retiredAt: string | null;
}

const MAX_CREATORS = 20;
const DAY = 86_400_000;
const GENDERS = ['woman', 'man'] as const;
const AGES = ['18-24', '25-34', '35-44', '45-60'] as const;
const SETTINGS = ['kitchen', 'living_room', 'car', 'outdoors', 'bathroom', 'desk', 'shop'] as const;
const REAL_PERSON = /\b(celebrit(?:y|ies)|famous|look-?alike|impersonat\w*|deep ?fake)\b/i;

const PALETTES = [
  { bg: '#f3e1cf', skin: '#c68863', hair: '#2d1b12', top: '#c9a227' },
  { bg: '#dce9e4', skin: '#8d5a3b', hair: '#1a1a1a', top: '#2f4f6f' },
  { bg: '#ece3f3', skin: '#e2b18f', hair: '#7a3b1d', top: '#5f8a5a' },
  { bg: '#e6eef7', skin: '#b07650', hair: '#4a3324', top: '#a8432e' },
] as const;

/** A head-and-shoulders illustration as a data: URL (sample media, clearly marked). */
function portrait(seed: number): string {
  const p = PALETTES[seed % PALETTES.length] ?? PALETTES[0];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400"><rect width="300" height="400" fill="${p.bg}"/><path d="M40 400c0-80 50-120 110-120s110 40 110 120z" fill="${p.top}"/><rect x="128" y="230" width="44" height="60" rx="18" fill="${p.skin}"/><ellipse cx="150" cy="180" rx="62" ry="74" fill="${p.skin}"/><path d="M86 170c0-56 30-88 64-88s66 30 66 88c-14-30-40-44-66-44s-50 14-64 44z" fill="${p.hair}"/><circle cx="128" cy="186" r="5" fill="#2b2b2b"/><circle cx="172" cy="186" r="5" fill="#2b2b2b"/><path d="M130 220q20 16 40 0" stroke="#7a3a2a" stroke-width="4" fill="none" stroke-linecap="round"/><text x="150" y="388" font-family="sans-serif" font-size="16" text-anchor="middle" fill="#00000080">SAMPLE</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const seededAt = new Date(Date.now() - 12 * DAY).toISOString();

const creators: DemoCreator[] = [
  {
    id: 'cr-maya',
    businessId: DEMO_BUSINESS_ID,
    name: 'Maya',
    gender: 'woman',
    ageRange: '25-34',
    setting: 'kitchen',
    appearance: 'shoulder-length dark curls, a mustard knit jumper',
    voiceTone: 'warm and upbeat',
    status: 'READY',
    isDefault: true,
    useCount: 4,
    lastUsedAt: new Date(Date.now() - 2 * DAY).toISOString(),
    portraitError: null,
    portraitSource: 'GENERATED',
    portraitUrl: portrait(0),
    createdAt: seededAt,
    retiredAt: null,
  },
  {
    id: 'cr-tom',
    businessId: DEMO_BUSINESS_ID,
    name: 'Tom',
    gender: 'man',
    ageRange: '35-44',
    setting: 'shop',
    appearance: 'short black hair, a navy apron over a white T-shirt',
    voiceTone: 'calm and friendly',
    status: 'READY',
    isDefault: false,
    useCount: 1,
    lastUsedAt: new Date(Date.now() - 6 * DAY).toISOString(),
    portraitError: null,
    portraitSource: 'GENERATED',
    portraitUrl: portrait(1),
    createdAt: seededAt,
    retiredAt: null,
  },
];

let portraits = 2;

const bad = (message: string, details?: Record<string, unknown>) =>
  new DemoHttpError(400, 'validation_error', message, details);

function find(businessId: string, id: string): DemoCreator {
  const c = creators.find((x) => x.id === id && x.businessId === businessId);
  if (!c) throw new DemoHttpError(404, 'not_found', 'Creator not found');
  return c;
}

const order: Record<Status, number> = { READY: 0, DRAFT: 1, RETIRED: 2 };

function refuseRealPerson(...texts: Array<string | null | undefined>) {
  if (texts.some((t) => t && REAL_PERSON.test(t)))
    throw bad('Creators are generated people.', { reason: 'ugc_real_person_refused' });
}

function fieldsOf(
  read: (k: string) => string,
): Omit<
  DemoCreator,
  'id' | 'businessId' | 'status' | 'isDefault' | 'useCount' | 'lastUsedAt' | 'portraitError'
> & { createdAt: string } {
  const name = read('name').trim();
  const gender = read('gender') as DemoCreator['gender'];
  const ageRange = read('ageRange') as DemoCreator['ageRange'];
  const setting = read('setting') as DemoCreator['setting'];
  if (!name || name.length > 60) throw bad('name must be 1–60 characters');
  if (!GENDERS.includes(gender) || !AGES.includes(ageRange) || !SETTINGS.includes(setting))
    throw bad('Invalid creator presets');
  const appearance = read('appearance').trim() || null;
  const voiceTone = read('voiceTone').trim() || null;
  refuseRealPerson(name, appearance, voiceTone);
  return {
    name,
    gender,
    ageRange,
    setting,
    appearance,
    voiceTone,
    portraitSource: null,
    portraitUrl: null,
    createdAt: new Date().toISOString(),
    retiredAt: null,
  };
}

function assertRoom(businessId: string) {
  const live = creators.filter((c) => c.businessId === businessId && c.status !== 'RETIRED');
  if (live.length >= MAX_CREATORS)
    throw new DemoHttpError(409, 'conflict', 'Creator limit reached', {
      reason: 'creator_limit',
      max: MAX_CREATORS,
    });
}

route('GET', '/businesses/:id/creators', ({ params, query }) => {
  const all = query.get('includeRetired') === 'true';
  return {
    data: creators
      .filter((c) => c.businessId === params.id && (all || c.status !== 'RETIRED'))
      .sort((a, b) => order[a.status] - order[b.status] || b.useCount - a.useCount)
      .map((c) => ({ ...c })),
  };
});

route('POST', '/businesses/:id/creators', ({ params, body }) => {
  const businessId = params.id ?? '';
  assertRoom(businessId);
  const input = (body ?? {}) as Record<string, unknown>;
  const fields = fieldsOf((k) => (typeof input[k] === 'string' ? (input[k] as string) : ''));
  const created: DemoCreator = {
    ...fields,
    id: `cr-${Date.now().toString(36)}`,
    businessId,
    status: 'READY',
    isDefault: false,
    useCount: 0,
    lastUsedAt: null,
    portraitError: null,
    portraitSource: 'GENERATED',
    portraitUrl: portrait(portraits++),
  };
  creators.push(created);
  return { status: 201, body: { creator: { ...created } } };
});

route('POST', '/businesses/:id/creators/upload', ({ params, body }) => {
  if (!(body instanceof FormData)) throw bad('Upload must be multipart/form-data');
  const businessId = params.id ?? '';
  assertRoom(businessId);
  const text = (k: string) => {
    const v = body.get(k);
    return typeof v === 'string' ? v : '';
  };
  const fields = fieldsOf(text);
  if (text('consent') !== 'true')
    throw bad('consent must be true: you must have the person’s consent and the rights');
  const photo = body.get('photo');
  if (!photo || typeof photo === 'string' || !['image/png', 'image/jpeg'].includes(photo.type))
    throw bad('photo must be a PNG or JPEG image');
  const created: DemoCreator = {
    ...fields,
    id: `cr-${Date.now().toString(36)}`,
    businessId,
    status: 'READY',
    isDefault: false,
    useCount: 0,
    lastUsedAt: null,
    portraitError: null,
    portraitSource: 'UPLOAD',
    portraitUrl: URL.createObjectURL(photo),
  };
  creators.push(created);
  return { status: 201, body: { creator: { ...created } } };
});

route('PATCH', '/businesses/:id/creators/:creatorId', ({ params, body }) => {
  const c = find(params.id ?? '', params.creatorId ?? '');
  if (c.status === 'RETIRED') throw new DemoHttpError(409, 'conflict', 'This creator is retired');
  const input = (body ?? {}) as { name?: unknown; voiceTone?: unknown; isDefault?: unknown };
  if (typeof input.name === 'string') {
    if (!input.name.trim() || input.name.length > 60) throw bad('name must be 1–60 characters');
    refuseRealPerson(input.name);
    c.name = input.name.trim();
  }
  if (typeof input.voiceTone === 'string') c.voiceTone = input.voiceTone.trim() || null;
  if (input.isDefault === true) {
    if (c.status !== 'READY')
      throw new DemoHttpError(409, 'conflict', 'Only a ready creator can be the default');
    for (const other of creators) if (other.businessId === c.businessId) other.isDefault = false;
    c.isDefault = true;
  }
  return { creator: { ...c } };
});

route('POST', '/businesses/:id/creators/:creatorId/regenerate', ({ params, body }) => {
  const c = find(params.id ?? '', params.creatorId ?? '');
  if (c.status === 'RETIRED') throw new DemoHttpError(409, 'conflict', 'This creator is retired');
  const input = (body ?? {}) as { instructions?: unknown };
  refuseRealPerson(typeof input.instructions === 'string' ? input.instructions : null);
  c.portraitUrl = portrait(portraits++);
  c.portraitSource = 'GENERATED';
  c.portraitError = null;
  c.status = 'READY';
  return { creator: { ...c } };
});

route('POST', '/businesses/:id/creators/:creatorId/retire', ({ params }) => {
  const c = find(params.id ?? '', params.creatorId ?? '');
  c.status = 'RETIRED';
  c.isDefault = false;
  c.retiredAt = new Date().toISOString();
  return { creator: { ...c } };
});
