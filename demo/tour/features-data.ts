import { LIBRARY_VIDEOS, P17_PROJECTS, PROJECTS } from '../api/ids';
import { projectHref as p, withLang, withPlan } from './workflow-types';
import { PRICE_TEXT } from './price-text';
import { SHARE_TOKEN } from './workflows-create';

// "Everything built" (#/tour/features): every completed feature of Phases 1–20, grouped by area,
// each with one line and a "See it" link into the demo. Plain data so demo/tour/links.test.ts can
// check every link against the routes demo/app.tsx knows. Features with no screen link to the
// behind-the-scenes page (`?section=` scrolls to the chapter). The operator / dependency items
// that are not built stay on #/tour/not-built.

export interface Feature {
  title: string;
  description: string;
  href: string;
  /** Where it came from (phase or backlog item). */
  phase: string;
}

export interface FeatureSection {
  id: string;
  label: string;
  features: Feature[];
}

const [firstRef] = LIBRARY_VIDEOS;
const spring = p(PROJECTS.springMenu.id);

export const FEATURE_SECTIONS: FeatureSection[] = [
  {
    id: 'create',
    label: 'Create',
    features: [
      {
        title: 'Brief to video',
        description:
          'One sentence becomes an ideation brief, scripts and shot lists for each platform, then assets, voice, music, composition and renders.',
        href: '#/new',
        phase: '1–9',
      },
      {
        title: 'Live pipeline strip',
        description:
          'The 9 layers advance while the page polls: planning, assets, voice, music, composition, quality.',
        href: p(PROJECTS.loyaltyCard.id),
        phase: '5',
      },
      {
        title: 'Templates',
        description:
          'Built-in and saved project templates (“Introduce yourself”, “Weekly special”) prefill the brief, formats and publishing.',
        href: '#/templates',
        phase: 'A5.4, 15.E7',
      },
      {
        title: 'Slideshows',
        description:
          'Listicle, before/after and photo-dump slideshows from the image library; auto-populate, edit, reorder, save as template.',
        href: p(PROJECTS.fiveBakes.id),
        phase: 'v1.1',
      },
      {
        title: 'Text overlays',
        description:
          'Hook, caption and CTA presets, font, colour, position and timing on a timeline; preview and re-render without new footage.',
        href: spring,
        phase: 'v1.1',
      },
      {
        title: 'Upload your own video',
        description:
          'Upload a phone video; captions come from the speech and each format is cropped from it.',
        href: '#/new',
        phase: '13.5',
      },
      {
        title: 'Draft briefs and budgets',
        description:
          'Save a brief as a draft; each project has a cost budget and pauses at 90% until raised.',
        href: p(PROJECTS.christmas.id),
        phase: '13.20',
      },
      {
        title: 'Quality tier per run',
        description: 'Generate a run on a lower tier than the plan to save cost.',
        href: p(PROJECTS.meetTheBakers.id),
        phase: '15.C4',
      },
    ],
  },
  {
    id: 'review',
    label: 'Review',
    features: [
      {
        title: 'Review screen',
        description:
          'Every variant side by side with Shots, Script, Overlays and Publish tabs; approve or reject with a note.',
        href: spring,
        phase: '8',
      },
      {
        title: 'Quality gate',
        description:
          'Loudness, captions, safe areas, brand kit and content safety; failures explained with numbers in the reader’s language.',
        href: p(PROJECTS.hotCrossBuns.id),
        phase: '8, 17.9',
      },
      {
        title: 'Force-approve with a note',
        description:
          'Override a failed check deliberately (never content safety); staff review every override.',
        href: '#/admin?tab=force-approvals',
        phase: '13',
      },
      {
        title: 'Regenerate a shot',
        description: 'Redo one shot with a prompt override instead of the whole video.',
        href: spring,
        phase: '8',
      },
      {
        title: 'Approval workflows',
        description:
          'Multi-step sign-off by role and count, per business, platform or tag (Standard and up).',
        href: '#/approvals',
        phase: '15.D3',
      },
      {
        title: 'Auto-approve for trusted creators',
        description:
          'Clean runs by creators with 10+ human-approved projects approve themselves (never Enterprise).',
        href: p(PROJECTS.morningRitual.id),
        phase: '13.18',
      },
      {
        title: 'Share for feedback',
        description:
          'A public link where outsiders watch and comment; approving stays inside Studio.',
        href: `#/p/${SHARE_TOKEN}`,
        phase: '15.E5',
      },
      {
        title: 'Failure reasons explained',
        description:
          'Kill-switch, provider and safety failures shown as sentences in the reader’s language.',
        href: p(P17_PROJECTS.gardenBakes.id),
        phase: '17.9',
      },
    ],
  },
  {
    id: 'library',
    label: 'Library',
    features: [
      {
        title: 'Reference library',
        description:
          'Browse proven short videos by category, length and mood; recommended shelf for the business.',
        href: '#/library',
        phase: 'v1.1',
      },
      {
        title: 'Semantic search',
        description: 'Search the library in plain words.',
        href: '#/library',
        phase: 'v1.1',
      },
      {
        title: 'Blueprint and similar videos',
        description: 'A reference’s beat-by-beat timeline and its nearest neighbours.',
        href: `#/library/${firstRef.id}`,
        phase: 'v1.1',
      },
      {
        title: 'INSPIRE and TEMPLATE modes',
        description:
          'Borrow a reference’s feel (Standard) or copy its structure (Plus, with a lock badge below).',
        href: `#/new?reference=${firstRef.id}&mode=TEMPLATE`,
        phase: 'v1.1, 18.C',
      },
      {
        title: 'Library administration',
        description:
          'Staff ingest videos, watch ingestion, edit category or licence, retire, audit licences.',
        href: '#/admin?tab=library',
        phase: '15.D',
      },
    ],
  },
  {
    id: 'publishing',
    label: 'Publishing',
    features: [
      {
        title: 'Publish now or schedule',
        description:
          'Pick variants and accounts, publish or schedule; per-platform captions and hashtags.',
        href: spring,
        phase: '9',
      },
      {
        title: 'Publications',
        description: 'Every post across platforms: filter, retry, cancel or take down.',
        href: '#/publications',
        phase: '9',
      },
      {
        title: 'Calendar',
        description:
          'Scheduled and published posts on a month grid; drag or move a post to another day.',
        href: '#/calendar',
        phase: '13',
      },
      {
        title: 'Plan a month ahead',
        description:
          'One-click posting plans fill the drip queue; open slots show on the calendar for the month ahead.',
        href: '#/calendar',
        phase: '20.3',
      },
      {
        title: 'Plan my month',
        description:
          'Claude drafts a month of videos and slideshows (≤ 4 a day); edit the list, then everything is made and scheduled, with a review window.',
        href: '#/plans/new',
        phase: '20.9',
      },
      {
        title: 'Auto-publish',
        description: 'Approved projects post themselves to the targets chosen at creation.',
        href: p(PROJECTS.morningRitual.id),
        phase: '13',
      },
      {
        title: 'Partial failure and retry',
        description: 'One platform failing does not stop the others; retry it alone.',
        href: p(PROJECTS.wholesale.id),
        phase: '9',
      },
      {
        title: 'Platform limits handled',
        description:
          'YouTube quota deferral, rate limits and platform kill switches, each explained.',
        href: '#/publications',
        phase: '17.9',
      },
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    features: [
      {
        title: 'Overview',
        description: '7 / 30 / 90-day views, engagement and a daily series.',
        href: '#/analytics',
        phase: '10',
      },
      {
        title: 'By platform and top posts',
        description: 'Per-platform comparison and the best posts.',
        href: '#/analytics',
        phase: '13.A4',
      },
      {
        title: 'Per-publication analytics',
        description: 'One post’s numbers over time.',
        href: '#/analytics/publications/pub-class-tiktok',
        phase: '13.A4',
      },
      {
        title: 'Spend by provider',
        description: 'What the AI providers cost this period.',
        href: '#/analytics',
        phase: '13.19',
      },
    ],
  },
  {
    id: 'business',
    label: 'Business',
    features: [
      {
        title: 'Business profile',
        description: 'What the business does, its tone and audience: every script uses it.',
        href: '#/business',
        phase: '10.9',
      },
      {
        title: 'Website scan',
        description:
          'Scan the business’s site with a recorded ownership statement; DNS verification; rescans.',
        href: '#/business',
        phase: '10.9, 17.8',
      },
      {
        title: 'Brand kits',
        description: 'Logo, colours, fonts and end cards, extracted from the logo in three clicks.',
        href: '#/business',
        phase: '13',
      },
      {
        title: 'Image library',
        description:
          'Scraped, stock, uploaded and generated images with semantic search (generation on Plus).',
        href: '#/business',
        phase: 'v1.1',
      },
      {
        title: 'Brand voice',
        description: 'Clone a voice with recorded consent for narration (Plus).',
        href: withPlan('#/business', 'active_plus'),
        phase: '13.13',
      },
      {
        title: 'Several businesses',
        description: 'Switch businesses in the header or add one; the plan sets how many.',
        href: '#/welcome',
        phase: '18.D',
      },
    ],
  },
  {
    id: 'connections',
    label: 'Connections',
    features: [
      {
        title: 'OAuth connections',
        description: 'TikTok, YouTube, LinkedIn and X connected by OAuth.',
        href: '#/connections',
        phase: '9',
      },
      {
        title: 'Facebook Login for Business',
        description: 'Studio’s own Meta login returns the Pages and linked Instagram accounts.',
        href: '#/connections',
        phase: '18.D',
      },
      {
        title: 'Daily access check',
        description:
          '“Access checked <date>”; a refused account asks to be reconnected, with a notification.',
        href: '#/connections',
        phase: '17.3',
      },
      {
        title: 'Bring your own provider keys',
        description:
          'Enterprise organisations use their own AI provider keys (lock badge below Enterprise).',
        href: '#/connections',
        phase: '15.C',
      },
    ],
  },
  {
    id: 'billing',
    label: 'Billing & plans',
    features: [
      {
        title: 'Pricing page',
        description:
          'Basic, Standard, Plus and Enterprise with a monthly / annual toggle, the comparison table, top-ups and FAQ.',
        href: '#/pricing',
        phase: '18.C',
      },
      {
        title: 'Billing settings',
        description:
          'Plan and status, renewal, usage against every limit, credits, top-ups and invoices.',
        href: '#/settings/billing',
        phase: '18.C',
      },
      {
        title: 'Checkout (simulated here)',
        description:
          'Choose a plan or top-up; the demo’s own clearly labelled checkout stands in for Stripe.',
        href: withPlan('#/settings/billing', 'no_plan'),
        phase: '18.C',
      },
      {
        title: '14-day Standard trial',
        description:
          'One trial per organisation with its own allowance and cost caps; a banner counts down.',
        href: withPlan('#/projects', 'trial'),
        phase: '18.C',
      },
      {
        title: 'Upgrade dialog',
        description:
          'Opens on plan_tier, quota_exceeded, plan_required and billing_required with the right next step.',
        href: withPlan(p(PROJECTS.meetTheBakers.id), 'active_basic'),
        phase: '18.C',
      },
      {
        title: 'Lock badges',
        description:
          'Voice clone, TEMPLATE mode, image generation, BYOC and custom presets show the plan they need.',
        href: withPlan('#/business', 'active_standard'),
        phase: '18.C',
      },
      {
        title: 'Top-up packs',
        description:
          'One-off video credits, used after the plan allowance; they raise that month’s cost cap.',
        href: withPlan('#/settings/billing', 'active_basic'),
        phase: '18.C',
      },
      {
        title: 'Past due and read-only',
        description:
          'Seven days of grace with a banner, then read-only: changes refused, export still allowed.',
        href: withPlan('#/settings/billing', 'past_due'),
        phase: '18.C',
      },
      {
        title: 'No plan yet',
        description: 'Sign up and set up for free; generate, publish and scan need a plan (402).',
        href: withPlan('#/projects', 'no_plan'),
        phase: '18.C',
      },
      {
        title: 'Billing emails',
        description:
          'Trial ending, payment failed, cancelled, top-up receipt, retention notice, in the reader’s language.',
        href: '#/tour/email/paymentFailed',
        phase: '18.B',
      },
    ],
  },
  {
    id: 'accounts',
    label: 'Accounts & teams',
    features: [
      {
        title: 'Landing and legal pages',
        description:
          'The public home page and operator-supplied terms, privacy, cookies, AUP, DPA and sub-processors.',
        href: '#/',
        phase: '18.E1–E2',
      },
      {
        title: 'Sign up and verify',
        description:
          'Email and password (strength meter, breached-password check) or Google; email verification.',
        href: '#/sign-up',
        phase: '18.A',
      },
      {
        title: 'Sign in with two-step verification',
        description: 'Password then an authenticator code or backup code.',
        href: '#/sign-in',
        phase: '18.A',
      },
      {
        title: 'Onboarding',
        description: 'Organisation, first business, brand kit, connect, first video.',
        href: '#/welcome?new=organisation',
        phase: '18.E3',
      },
      {
        title: 'Organisation settings',
        description:
          'Name, logo, country, language; transfer ownership and delete, both with the password.',
        href: '#/settings/organisation',
        phase: '18.E4',
      },
      {
        title: 'Members and roles',
        description: 'Invite by email and role, change roles, seat meter, last-owner protection.',
        href: '#/settings/members',
        phase: '18.E4',
      },
      {
        title: 'Invitations',
        description: 'The invitee’s accept screen.',
        href: '#/invite/inv-demo',
        phase: '18.A',
      },
      {
        title: 'Audit log',
        description: 'Who did what: members, settings, billing, connections.',
        href: '#/settings/audit',
        phase: '18.E4',
      },
      {
        title: 'Account security',
        description:
          'Password, 2FA with backup codes, active sessions, Google link, delete the account.',
        href: '#/account/security',
        phase: '18.A2',
      },
      {
        title: 'Profile',
        description: 'Name, email language and email change.',
        href: '#/account/profile',
        phase: '18.A',
      },
      {
        title: 'Export your data',
        description: 'A ZIP of everything the organisation has in Studio, tokens never included.',
        href: '#/account/export',
        phase: '15.E1',
      },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    features: [
      {
        title: 'Kill switch',
        description: 'Four levels plus per-platform; global needs a second person.',
        href: '#/admin?tab=kill-switch',
        phase: '10.11',
      },
      {
        title: 'Bulk re-drive',
        description: 'Preview then apply exactly the stopped or failed work.',
        href: '#/admin?tab=redrive',
        phase: '13',
      },
      {
        title: 'Organisations and users',
        description: 'Search, ban with a reason, sign out everywhere, reset 2FA (audited).',
        href: '#/admin?tab=users',
        phase: '18.E5',
      },
      {
        title: 'Subscriptions and MRR',
        description: 'MRR by tier and status, past-due grace dates.',
        href: '#/admin?tab=billing',
        phase: '18.C',
      },
      {
        title: 'Enterprise overrides',
        description: `Custom limits with the minimum-price check (${PRICE_TEXT.enterpriseCap} cap → at least ${PRICE_TEXT.enterpriseMinimum} a month).`,
        href: '#/admin?tab=billing',
        phase: '18.C',
      },
      {
        title: 'Cost report and caps',
        description: 'Today’s caps, top spenders, projects near budget; per-organisation caps.',
        href: '#/admin?tab=cost',
        phase: '13.19',
      },
      {
        title: 'Queues, providers and dead letters',
        description: 'Queue health, provider health, inspect and requeue failed jobs.',
        href: '#/admin?tab=dead-letters',
        phase: '15.D',
      },
      {
        title: 'Safety review and audit',
        description: 'Human review of flagged videos and a sampled audit of passed ones.',
        href: '#/admin?tab=safety-audit',
        phase: '14',
      },
      {
        title: 'Beta programme',
        description: 'Cohorts, “Plus for 30 days”, and feedback.',
        href: '#/admin?tab=beta',
        phase: '14.11',
      },
      {
        title: 'Feature flags',
        description: 'Turn features on per organisation.',
        href: '#/admin?tab=features',
        phase: '15.D',
      },
    ],
  },
  {
    id: 'languages',
    label: 'Languages',
    features: [
      {
        title: '11 interface languages',
        description:
          'en-GB, en-US, fr, es, ar, de, it, pt-BR, pt-PT, hi and zh-Hans, switchable in the header.',
        href: '#/projects',
        phase: '16.1',
      },
      {
        title: 'Right-to-left Arabic',
        description: 'Mirrored layout on logical CSS; Arabic plural forms.',
        href: withLang('#/projects', 'ar'),
        phase: '16.2',
      },
      {
        title: 'Chinese (Simplified)',
        description: 'Every screen, with locale formatting of dates and GBP.',
        href: withLang('#/settings/billing', 'zh-Hans'),
        phase: '16.3',
      },
      {
        title: 'Notifications and emails in the reader’s language',
        description: 'Keyed messages rendered per reader, in the bell and in email.',
        href: withLang('#/tour/email/trialEnding', 'ar'),
        phase: '16.5, 18.B',
      },
    ],
  },
  {
    id: 'reliability',
    label: 'Reliability & ops',
    features: [
      {
        title: '9-layer pipeline and workers',
        description: 'Each layer a queue job; provider router with failover and circuit breakers.',
        href: '#/tour/system?section=pipeline',
        phase: '1–9',
      },
      {
        title: 'Cost caps',
        description: 'Daily and monthly caps per plan; generation pauses at 100%.',
        href: '#/tour/system?section=cost',
        phase: '12',
      },
      {
        title: 'Lost-post re-drive and account checks',
        description:
          'Scheduled posts whose jobs vanished are re-driven once; accounts checked daily.',
        href: '#/tour/system?section=reliability',
        phase: '17.2–17.3',
      },
      {
        title: 'Provider failover alert',
        description: 'Alerts when routings pass a provider over too often.',
        href: '#/tour/system?section=failover',
        phase: '17.4',
      },
      {
        title: 'Storage backup',
        description: 'Nightly copy of every bucket, deleted objects aged out after 30 days.',
        href: '#/tour/system?section=backup',
        phase: '17.5',
      },
      {
        title: 'Rate limits and security',
        description: 'Per-route limits, signed URLs, CSRF and origin checks, encrypted tokens.',
        href: '#/tour/system?section=security',
        phase: '11, 18.A',
      },
      {
        title: 'Alerting and runbooks',
        description: 'Prometheus rules, Alertmanager routing and a runbook per alert.',
        href: '#/tour/system?section=alerts',
        phase: '14',
      },
    ],
  },
  {
    id: 'deployment',
    label: 'Deployment',
    features: [
      {
        title: 'Single server (Hetzner)',
        description:
          'Docker Compose on one server: Caddy HTTPS, Postgres with pgBackRest, Valkey, web and worker.',
        href: '#/tour/system?section=deploy',
        phase: 'VPS',
      },
      {
        title: 'Cloudflare R2 storage',
        description: 'R2 as an alternative to S3, with lifecycle rules and presigned uploads.',
        href: '#/tour/system?section=storage',
        phase: 'R2',
      },
      {
        title: 'Render blueprint',
        description: 'The alternative managed deployment, validated in CI.',
        href: '#/tour/whats-new?section=deployment',
        phase: 'Render',
      },
      {
        title: 'Load test and golden paths',
        description: 'k6 smoke and load profiles; golden-path checks after each deploy.',
        href: '#/tour/system?section=k6',
        phase: '14',
      },
      {
        title: 'Standalone or with PostMind Core',
        description: 'Studio runs as its own SaaS by default, or behind Core with the adapters on.',
        href: '#/tour/whats-new?section=phase-18',
        phase: '18.0',
      },
    ],
  },
];

/** Every link on the page, for the test. */
export function featureLinks(): string[] {
  return FEATURE_SECTIONS.flatMap((s) => s.features.map((f) => f.href));
}
