import { LIBRARY_VIDEOS, P17_PROJECTS, PROJECTS } from '../api/ids';
import type { SceneKind } from '../media';

// The tour's screen index: every screen of the app and its notable deep states, grouped the way
// the app's own navigation groups them (app-shell.tsx NAV: Make, Manage, Set up, PostMind staff).

export interface DeepLink {
  href: string;
  label: string;
  note: string;
}

export interface ScreenEntry {
  title: string;
  href: string;
  summary: string;
  scene: SceneKind;
  /** Show a recorded sample clip instead of a still. */
  video?: string;
  links?: DeepLink[];
  /** Things to try that live in tabs or dialogs (not addressable by URL). */
  tryIt?: string[];
}

export interface ScreenGroup {
  key: string;
  label: string;
  intro: string;
  screens: ScreenEntry[];
}

const p = (id: string) => `#/projects/${id}`;

export const PROJECT_STATES: DeepLink[] = [
  {
    href: p(PROJECTS.springMenu.id),
    label: PROJECTS.springMenu.name,
    note: 'Ready for review: three variants (TikTok, Shorts, Reels), shot strip, quality panel, approve or reject.',
  },
  {
    href: p(PROJECTS.sourdoughClass.id),
    label: PROJECTS.sourdoughClass.name,
    note: 'Published to TikTok, YouTube Shorts and Instagram; publications and analytics flowing.',
  },
  {
    href: p(PROJECTS.loyaltyCard.id),
    label: PROJECTS.loyaltyCard.name,
    note: 'Rendering live: the pipeline strip advances while the page polls.',
  },
  {
    href: p(PROJECTS.hotCrossBuns.id),
    label: PROJECTS.hotCrossBuns.name,
    note: 'Quality failed (loudness outside −18…−10 LUFS): see the failed check, force-approve with a note.',
  },
  {
    href: p(PROJECTS.fiveBakes.id),
    label: PROJECTS.fiveBakes.name,
    note: 'Slideshow (Listicle 5): slide editor, reorder, auto-populate, save as template.',
  },
  {
    href: p(PROJECTS.morningRitual.id),
    label: PROJECTS.morningRitual.name,
    note: 'From a library reference (TEMPLATE mode), approved automatically, auto-publish targets armed.',
  },
  {
    href: p(PROJECTS.wholesale.id),
    label: PROJECTS.wholesale.name,
    note: 'Partially published: YouTube live, LinkedIn failed with a retry.',
  },
  {
    href: p(PROJECTS.christmas.id),
    label: PROJECTS.christmas.name,
    note: 'Budget paused (cost_cap_paused at 90% of its budget): Raise budget, then Generate again.',
  },
  {
    href: p(PROJECTS.meetTheBakers.id),
    label: PROJECTS.meetTheBakers.name,
    note: 'Draft: brief saved, nothing generated yet.',
  },
  {
    href: p(P17_PROJECTS.untitled.id),
    label: 'Untitled video (no name)',
    note: 'Ready for review with no name: lists, review and the bell show “Untitled video” in the reader’s language; quality details with numbers (17.9).',
  },
  {
    href: p(P17_PROJECTS.easterWindow.id),
    label: P17_PROJECTS.easterWindow.name,
    note: 'Failed while planning because a workspace kill switch was engaged: both sentences translated (17.9).',
  },
  {
    href: p(P17_PROJECTS.gardenBakes.id),
    label: P17_PROJECTS.gardenBakes.name,
    note: 'Shots 2 and 4 could not be generated; each shot shows its provider’s error class translated and its message as sent (17.9).',
  },
  {
    href: p(P17_PROJECTS.knifeSkills.id),
    label: P17_PROJECTS.knifeSkills.name,
    note: 'Blocked by the content-safety scan of the rendered video (17.9).',
  },
];

const [firstLibrary] = LIBRARY_VIDEOS;

// Phase 18 (standalone SaaS): the public pages, onboarding, organisation settings and the new
// admin tabs. Sign-up, pricing and billing are Tracks A and C; their entries say so.
const PHASE_18_GROUP: ScreenGroup = {
  key: 'standalone',
  label: 'Standalone SaaS (Phase 18)',
  intro:
    'Studio as its own product: a public site, sign-up, organisations with members and roles, plans, and a staff console to run it.',
  screens: [
    {
      title: 'Landing page',
      href: '#/',
      summary:
        'The public home page at /: the product story for small businesses, sample formats, the three-step flow and calls to sign up or see pricing. Signed-in visitors go straight to Projects.',
      scene: 'storefront',
      links: [
        {
          href: '#/legal/terms',
          label: 'Legal pages',
          note: 'Terms, privacy, cookies, acceptable use, DPA and sub-processors from the operator’s Markdown; a banner marks placeholders.',
        },
      ],
    },
    {
      title: 'Pricing',
      href: '#/pricing',
      summary:
        'Plan cards with a monthly / annual toggle, the comparison table and top-up packs. Prices here are the reference amounts; the live page reads them from Stripe.',
      scene: 'market',
    },
    {
      title: 'Sign up',
      href: '#/sign-up',
      summary:
        'Email and password or Google, with a strength meter, email verification and two-step verification. In the demo nothing is created: “Create account” goes to the check-your-email screen.',
      scene: 'baker',
    },
    {
      title: 'Guided setup',
      href: '#/welcome?new=organisation',
      summary:
        'Create the organisation (name, tax country, language), add the first business, then brand kit, connect a platform and make the first video.',
      scene: 'croissant',
      links: [
        {
          href: '#/welcome',
          label: 'Resume the wizard',
          note: 'Brand kit → Connect → First video → Celebrate.',
        },
      ],
    },
    {
      title: 'Organisation settings',
      href: '#/settings/organisation',
      summary:
        'Name, logo, tax country and default language; transfer ownership; delete the organisation after typing its name. The header now has an organisation switcher, a user menu with sign-out and a trial banner.',
      scene: 'flatlay',
    },
    {
      title: 'Members',
      href: '#/settings/members',
      summary:
        'Invite by email and role, change roles, remove people, resend or revoke invitations, and a seat meter with an upgrade prompt at the limit. The last owner cannot leave or be demoted.',
      scene: 'baker',
      tryIt: [
        'Invite someone as Viewer, then resend or revoke it.',
        'Try to demote yourself (the only owner): the refusal explains why.',
      ],
    },
    {
      title: 'Billing',
      href: '#/settings/billing',
      summary:
        'Plan and renewal date, usage meters against the plan limits, top-up credits and packs, invoices and “Manage billing”. The plan follows the demo bar’s plan switcher; checkout and the billing portal open a clearly labelled simulated page (no card details), never Stripe.',
      scene: 'coffee',
      links: [
        {
          href: '#/settings/billing?demoPlan=no_plan',
          label: 'No plan: the plan picker',
          note: 'Choose a plan or start the 14-day Standard trial, then the simulated checkout.',
        },
        {
          href: '#/settings/billing?demoPlan=past_due',
          label: 'Past due',
          note: 'Grace countdown, open invoice, “Update payment method”.',
        },
      ],
    },
    {
      title: 'Account security',
      href: '#/account/security',
      summary:
        'Password, two-step verification with backup codes, active sessions with revoke, Google sign-in, and deleting the account (password again; the only owner must transfer ownership first).',
      scene: 'studio',
    },
    {
      title: 'Audit log',
      href: '#/settings/audit',
      summary:
        'Who did what in the organisation: members, settings, billing, connections. Filter by category and load more.',
      scene: 'studio',
    },
    {
      title: 'Admin: organisations, users, subscriptions',
      href: '#/admin?tab=organisations',
      summary:
        'Staff (with two-step verification) search organisations and users, ban or sign someone out, reset 2FA and read subscriptions; a warning shows while the legal documents are placeholders. Viewing as a user is off by default and read-only when on.',
      scene: 'studio',
      links: [
        {
          href: '#/admin?tab=organisations',
          label: 'Organisations: plan, trial and cost caps',
          note: 'Open “PostMind (operator)” (on a trial, £14.96 of its £15 cap): set Plus, tick “End the trial now”, add a reason and confirm; Cost caps sit beside it.',
        },
        {
          href: '#/admin?tab=users',
          label: 'Users tab',
          note: 'Open a user, ban with a reason, sign them out everywhere.',
        },
        {
          href: '#/admin?tab=subscriptions',
          label: 'Subscriptions tab',
          note: 'Read-only list with status counts and past-due grace dates.',
        },
      ],
    },
  ],
};

export const SCREEN_GROUPS: ScreenGroup[] = [
  {
    key: 'make',
    label: 'Make',
    intro: 'From a sentence to a finished, reviewed video.',
    screens: [
      {
        title: 'Create',
        href: '#/new',
        summary:
          'One box, one button. Platforms pre-selected from connections; advanced options folded away.',
        scene: 'croissant',
        links: [
          {
            href: '#/new',
            label: 'Plain brief',
            note: 'Type a brief and press Generate (Ctrl/Cmd+Enter).',
          },
          {
            href: '#/new',
            label: 'From a template',
            note: 'Under Template, pick “Weekly special (Leeds Sourdough)” or the built-in “Introduce yourself and what you do”.',
          },
          {
            href: `#/new?reference=${firstLibrary.id}&mode=TEMPLATE`,
            label: 'With a library reference',
            note: `Banner for “${firstLibrary.title}” in TEMPLATE mode (copy its structure).`,
          },
        ],
      },
      {
        title: 'Projects',
        href: '#/projects',
        summary: 'Every project with its state, filterable by state, with cursor paging.',
        scene: 'sourdough',
        video: 'Spring menu launch',
        links: PROJECT_STATES,
      },
      {
        title: 'Reference library',
        href: '#/library',
        summary:
          'Browse proven videos by category, length and mood, or search the whole library in plain words; a recommended shelf for the business.',
        scene: 'baker',
        links: [
          {
            href: `#/library/${firstLibrary.id}`,
            label: firstLibrary.title,
            note: 'Blueprint timeline, similar videos, “Use as reference” in TEMPLATE or INSPIRE mode.',
          },
        ],
      },
      {
        title: 'Templates',
        href: '#/templates',
        summary:
          'Saved slideshow and project templates, with delete; built-in templates listed read-only (A5.4, 15.E7). Every category label is translated, as in the slideshow picker (17.9).',
        scene: 'flatlay',
      },
      {
        title: 'Share for feedback',
        href: '#/p/demoTokenSpringMenu000000000000000000000000',
        summary:
          'The public preview an outside reviewer opens from a share link: watch the variants and leave feedback (including right-to-left text); approving is not possible from a link (15.E5, decision P8).',
        scene: 'sourdough',
        tryIt: [
          'On a project’s review screen, “Share for feedback” creates, lists and revokes links.',
        ],
      },
    ],
  },
  {
    key: 'manage',
    label: 'Manage',
    intro: 'What is live, what is scheduled, and how it is doing.',
    screens: [
      {
        title: 'Publications',
        href: '#/publications',
        summary:
          'Every post across platforms: filter by state and platform; retry, cancel or take down. Failure reasons in the reader’s language (platform kill switch, rate limit, reconnect).',
        scene: 'storefront',
      },
      {
        title: 'Calendar',
        href: '#/calendar',
        summary:
          'Scheduled and published posts on a month grid; drag a scheduled post to another day, or use its move button (keyboard and phones).',
        scene: 'market',
      },
      {
        title: 'Analytics',
        href: '#/analytics',
        summary:
          '7 / 30 / 90-day overview, daily series, per-platform and top posts, spend by provider.',
        scene: 'coffee',
      },
    ],
  },
  {
    key: 'setup',
    label: 'Set up',
    intro: 'Teach Studio about the business once; every video uses it.',
    screens: [
      {
        title: 'Welcome',
        href: '#/welcome',
        summary:
          'First-run wizard: connect platforms, a brand kit from your logo in three clicks, a first video from the "Introduce yourself" template, then the go-live celebration.',
        scene: 'storefront',
      },
      {
        title: 'Business & images',
        href: '#/business',
        summary: 'Profile, website scan, brand kits and the image library.',
        scene: 'flatlay',
        tryIt: [
          'Profile tab: edit the tone and audience Studio writes with.',
          'Website scan tab: confirm ownership and scan the bakery’s website (progress polls every 3 s); the statement is sent as {locale, messageKey, text} and checked (17.8); the last scan stopped at its cost cap (translated reason); see the next automatic rescan, verify the domain with a DNS TXT record, or report a site you do not own.',
          'Brand kits tab: the main kit and a Christmas 2026 kit; set the default.',
          'Image library tab: filter by source, semantic search, generate an image.',
        ],
      },
      {
        title: 'Connections',
        href: '#/connections',
        summary:
          'TikTok, YouTube, LinkedIn and X by OAuth; Instagram and Facebook through Studio’s own Facebook Login for Business (simulated). The daily check shows “Access checked” on healthy accounts; X was refused and asks to be reconnected (17.3).',
        scene: 'street',
      },
      {
        title: 'Approval workflows',
        href: '#/approvals',
        summary:
          'Multi-step sign-off (spec 7.13): ordered steps of a role and how many approvers, applied by business, platform or tag — the most specific workflow wins.',
        scene: 'baker',
        tryIt: [
          'Create a workflow, reorder its steps, then edit or delete it.',
          'Open “Spring menu launch” (it targets Instagram Reels): the review screen shows “Step 1 of 2 — waiting for admin”; approve twice to finish.',
        ],
      },
      {
        title: 'Export data',
        href: '#/account/export',
        summary:
          'Right of access: request a ZIP of all the organisation’s Studio data (tokens never included); the download link lasts 7 days (15.E1).',
        scene: 'coffee',
      },
    ],
  },
  {
    key: 'staff',
    label: 'PostMind staff',
    intro: 'Operator tools for the platform team.',
    screens: [
      {
        title: 'Admin Centre',
        href: '#/admin',
        summary:
          'Kill switch, bulk re-drive, library ingestion and the cost report with today’s caps.',
        scene: 'studio',
        tryIt: [
          'Kill switch tab: engage a level (reason required; global needs typed confirmation), halt one platform, release.',
          'Re-drive tab: choose filters, Preview, then Apply for exactly what was previewed.',
          'Library tab: ingest a video, watch Ingestion status, edit category or licence, retire.',
          'Cost report tab: caps today, top organisations, projects over 80% of budget.',
          'Kill switch tab: a global kill waits for a second staff member; confirm Priya’s pending request (typed phrase) or withdraw it.',
          'Dead letters tab: inspect a failed job, requeue a generate-asset job with another provider, drain a queue by typing its name.',
          'Force-approvals tab: review quality-gate overrides with the customer’s note and the failed checks.',
        ],
      },
    ],
  },
  PHASE_18_GROUP,
];

export const BELL_NOTE =
  'The bell in the top bar lists in-app notifications in the reader’s language (cost alerts, generation complete, approval waiting, publication failed, safety reviews, plan quota, “Reconnect your X account”, and one for an untitled project). One old row has no message key and stays in its stored English. Mark one or all as read.';
