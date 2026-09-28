// Client view of GET|PATCH /api/studio/onboarding (src/lib/studio/services/onboarding.ts) and the
// wizard's pure step logic (BACKLOG 13.14, spec 14.5).

export const WIZARD_STEPS = ['connect', 'brand_kit', 'first_video', 'celebrate'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];
export type OnboardingStep = WizardStep | 'done';

export interface Onboarding {
  step: OnboardingStep;
  completed: WizardStep[];
  firstVideoProjectId: string | null;
  dismissedAt: string | null;
  startedAt: string | null;
  suggested: boolean;
}

export interface OnboardingResponse {
  ok: true;
  onboarding: Onboarding;
}

export interface OnboardingPatch {
  step?: OnboardingStep;
  completed?: WizardStep[];
  firstVideoProjectId?: string | null;
  dismissed?: boolean;
}

export const ONBOARDING_PATH = '/onboarding';

/** Catalogue key (onboarding.steps.<key>) of each step's label. */
export const STEP_KEY = {
  connect: 'connect',
  brand_kit: 'brandKit',
  first_video: 'firstVideo',
  celebrate: 'celebrate',
} as const satisfies Record<WizardStep, string>;

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

export function nextStep(step: WizardStep): OnboardingStep {
  return WIZARD_STEPS[stepIndex(step) + 1] ?? 'done';
}

export function previousStep(step: WizardStep): WizardStep {
  return WIZARD_STEPS[Math.max(0, stepIndex(step) - 1)] ?? 'connect';
}

/** The completed list with `step` added (kept in wizard order, no duplicates). */
export function withCompleted(completed: WizardStep[], step: WizardStep): WizardStep[] {
  return WIZARD_STEPS.filter((s) => s === step || completed.includes(s));
}
