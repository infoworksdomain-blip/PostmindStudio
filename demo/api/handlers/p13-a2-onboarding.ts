// Phase 13 track A2 demo handlers: the /welcome first-run wizard state (13.14, spec 14.5) and the
// logo palette extraction. Shapes match src/lib/studio/services/onboarding.ts (getOnboarding /
// patchOnboarding) and src/app/api/studio/brand-kits/extract/route.ts.
import { DemoHttpError, route } from '../registry';
import { allProjects } from './projects-store';

const STEPS = ['connect', 'brand_kit', 'first_video', 'celebrate'] as const;
type Step = (typeof STEPS)[number];
type AnyStep = Step | 'done';

interface State {
  step: AnyStep;
  completed: Step[];
  firstVideoProjectId: string | null;
  dismissedAt: string | null;
  startedAt: string | null;
}

let state: State = {
  step: 'connect',
  completed: [],
  firstVideoProjectId: null,
  dismissedAt: null,
  startedAt: null,
};

const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
/** A warm bakery palette: every upload "extracts" the same plausible colours. */
const DEMO_PALETTE = ['#2B1D14', '#C6452D', '#F3E7D3'];

const bad = (problems: string[]) =>
  new DemoHttpError(400, 'validation_error', 'Invalid request body', { problems });

function view() {
  return {
    onboarding: {
      ...state,
      completed: [...state.completed],
      suggested: !state.dismissedAt && state.step !== 'done',
    },
  };
}

const isStep = (v: unknown): v is AnyStep =>
  v === 'done' || (typeof v === 'string' && (STEPS as readonly string[]).includes(v));

function parsePatch(body: unknown): Partial<State> & { dismissed?: boolean } {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw bad(['Expected an object']);
  const input = body as Record<string, unknown>;
  const allowed = new Set(['step', 'completed', 'firstVideoProjectId', 'dismissed']);
  const unknownKeys = Object.keys(input).filter((k) => !allowed.has(k));
  if (unknownKeys.length) throw bad([`Unrecognized key(s): ${unknownKeys.join(', ')}`]);
  if (Object.keys(input).length === 0) throw bad(['Nothing to update']);
  const out: Partial<State> & { dismissed?: boolean } = {};
  if ('step' in input) {
    if (!isStep(input.step)) throw bad(['step: Invalid option']);
    out.step = input.step;
  }
  if ('completed' in input) {
    const list = input.completed;
    if (!Array.isArray(list) || list.some((s) => !isStep(s) || s === 'done'))
      throw bad(['completed: Invalid option']);
    out.completed = STEPS.filter((s) => list.includes(s));
  }
  if ('firstVideoProjectId' in input) {
    const id = input.firstVideoProjectId;
    if (id !== null && (typeof id !== 'string' || id.length < 1 || id.length > 64))
      throw bad(['firstVideoProjectId: Invalid input']);
    if (id && !allProjects().some((p) => p.id === id))
      throw new DemoHttpError(
        400,
        'validation_error',
        'firstVideoProjectId is not a project in this organisation',
      );
    out.firstVideoProjectId = id;
  }
  if ('dismissed' in input) {
    if (typeof input.dismissed !== 'boolean') throw bad(['dismissed: Invalid input']);
    out.dismissed = input.dismissed;
  }
  return out;
}

route('GET', '/onboarding', () => view());

route('PATCH', '/onboarding', ({ body }) => {
  const { dismissed, ...fields } = parsePatch(body);
  state = {
    ...state,
    ...fields,
    ...(dismissed !== undefined && { dismissedAt: dismissed ? new Date().toISOString() : null }),
    startedAt: state.startedAt ?? new Date().toISOString(),
  };
  return view();
});

route('POST', '/brand-kits/extract', ({ body }) => {
  const logo = body instanceof FormData ? body.get('logo') : null;
  if (!(logo instanceof File)) throw new DemoHttpError(400, 'validation_error', 'logo is required');
  if (logo.size === 0) throw new DemoHttpError(400, 'validation_error', 'The logo file is empty');
  if (logo.size > MAX_LOGO_BYTES)
    throw new DemoHttpError(400, 'validation_error', 'The logo must be at most 5 MB');
  if (!LOGO_TYPES.has(logo.type))
    throw new DemoHttpError(
      400,
      'validation_error',
      'The logo must be a PNG, JPEG, WebP, GIF or AVIF image',
    );
  return { palette: [...DEMO_PALETTE], suggestedFont: null };
});
