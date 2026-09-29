// Types for the "Not built yet" register (demo/tour/not-built-data.ts).

export type NotBuiltGroup =
  | 'Notifications'
  | 'Create and review'
  | 'Library and images'
  | 'Manage'
  | 'Business set-up'
  | 'Admin Centre'
  | 'Publishing and automation'
  | 'Pipeline and media'
  | 'Cost controls'
  | 'Infrastructure'
  | 'Staging and people (GATE 12)';

/** Why it is not built. */
export type Blocker =
  | 'missing endpoint'
  | 'blocked on a dependency'
  | 'needs staging'
  | 'needs people'
  | 'needs operator app settings'
  | 'not started';

export interface CompletionPlan {
  /** Screens or UI to add or change (empty when there is no UI work). */
  screens: string[];
  /** Endpoints, jobs, migrations or scripts to add. */
  endpoints: string[];
  /** Engineering effort estimate in working days (Studio side). */
  days: number;
  /** What must exist first, or "none". */
  dependsOn: string;
}

export interface NotBuiltItem {
  id: string;
  group: NotBuiltGroup;
  title: string;
  blocker: Blocker;
  /** Why it isn't built, in one or two sentences. */
  why: string;
  /** Where the gap is recorded in the repository. */
  source: string;
  plan: CompletionPlan;
}
