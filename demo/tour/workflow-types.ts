import type { SceneKind } from '../media';
import type { BillingStateId } from '../api/billing-state';

// Shared shape of the guided workflows (workflows*.ts). Every step links to the screen, tab or
// state it happens on; `?demoPlan=<state>` on a link switches the demo's plan first and
// `?lang=<locale>` its language, so a step can open e.g. the billing page already past due.

export interface WorkflowStep {
  text: string;
  href: string;
  cta: string;
}

export interface Workflow {
  id: string;
  title: string;
  outcome: string;
  /** Which part of the product it walks through (grouping on the Workflows page). */
  area: 'create' | 'billing' | 'team' | 'operate';
  scene: SceneKind;
  caption: string;
  steps: WorkflowStep[];
}

export const projectHref = (id: string) => `#/projects/${id}`;

/** A link that also switches the demo's plan and billing state (demo/api/billing-state.ts). */
export function withPlan(href: string, state: BillingStateId): string {
  return `${href}${href.includes('?') ? '&' : '?'}demoPlan=${state}`;
}

/** A link that also switches the interface language. */
export function withLang(href: string, locale: string): string {
  return `${href}${href.includes('?') ? '&' : '?'}lang=${locale}`;
}
