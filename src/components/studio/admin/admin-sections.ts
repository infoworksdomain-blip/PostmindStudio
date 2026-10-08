// BACKLOG 25.13 — the Admin Centre's sections, grouped for the side menu. The section id is the
// URL's ?tab= value: the ids from the old tab row are kept so existing deep links (the
// safety-review notification links to ?tab=safety) still open the right place. Subscriptions and
// Billing were two overlapping tabs; they are one section now, with sub-views in ?view=.

export const ADMIN_GROUPS = [
  {
    id: 'operations',
    sections: ['kill-switch', 'queues', 'dead-letters', 'redrive', 'providers'],
  },
  {
    id: 'content',
    sections: ['library', 'safety', 'safety-audit', 'force-approvals'],
  },
  {
    id: 'customers',
    sections: ['organisations', 'users', 'billing', 'usage', 'beta'],
  },
  {
    id: 'platform',
    sections: ['features', 'cost'],
  },
] as const;

export type AdminGroup = (typeof ADMIN_GROUPS)[number]['id'];
export type AdminSection = (typeof ADMIN_GROUPS)[number]['sections'][number];

export const ADMIN_SECTIONS: readonly AdminSection[] = ADMIN_GROUPS.flatMap((g) => g.sections);
export const DEFAULT_SECTION: AdminSection = 'kill-switch';

/** Section id → catalogue key under admin.centre.tabs. */
export const SECTION_KEY = {
  'kill-switch': 'killSwitch',
  queues: 'queues',
  'dead-letters': 'deadLetters',
  redrive: 'redrive',
  providers: 'providers',
  library: 'library',
  safety: 'safety',
  'safety-audit': 'safetyAudit',
  'force-approvals': 'forceApprovals',
  organisations: 'organisations',
  users: 'users',
  billing: 'billing',
  usage: 'usage',
  beta: 'beta',
  features: 'features',
  cost: 'cost',
} as const satisfies Record<AdminSection, string>;

/** The sub-views of "Subscriptions & billing" (?view=). */
export const BILLING_VIEWS = ['overview', 'records', 'entitlements'] as const;
export type BillingView = (typeof BILLING_VIEWS)[number];
export const DEFAULT_BILLING_VIEW: BillingView = 'overview';

const isSection = (value: string): value is AdminSection =>
  (ADMIN_SECTIONS as readonly string[]).includes(value);

export const isBillingView = (value: string | null | undefined): value is BillingView =>
  !!value && (BILLING_VIEWS as readonly string[]).includes(value);

/** Old ?tab= values that now live inside another section. */
const LEGACY: Record<string, { section: AdminSection; view?: BillingView }> = {
  subscriptions: { section: 'billing', view: 'records' },
};

export interface ResolvedSection {
  section: AdminSection;
  view: BillingView;
}

/** What ?tab= and ?view= open: unknown values fall back to the kill switch and the overview. */
export function resolveSection(
  tab: string | null | undefined,
  view: string | null | undefined,
): ResolvedSection {
  const legacy = tab ? LEGACY[tab] : undefined;
  const section = legacy?.section ?? (tab && isSection(tab) ? tab : DEFAULT_SECTION);
  const resolvedView = isBillingView(view) ? view : (legacy?.view ?? DEFAULT_BILLING_VIEW);
  return { section, view: resolvedView };
}

/**
 * The query string for a section (and billing sub-view), as `?…` or ''. Other parameters are kept;
 * the defaults are left out so the plain /admin URL stays clean, and `view` only travels with the
 * billing section.
 */
export function sectionQuery(search: string, section: AdminSection, view?: BillingView): string {
  const params = new URLSearchParams(search);
  if (section === DEFAULT_SECTION) params.delete('tab');
  else params.set('tab', section);
  if (section === 'billing' && view && view !== DEFAULT_BILLING_VIEW) params.set('view', view);
  else params.delete('view');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** The group a section sits in. */
export function groupOf(section: AdminSection): AdminGroup {
  const group = ADMIN_GROUPS.find((g) => (g.sections as readonly string[]).includes(section));
  return group?.id ?? 'operations';
}
