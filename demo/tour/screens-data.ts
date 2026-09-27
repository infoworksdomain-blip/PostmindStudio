import { LIBRARY_VIDEOS, PROJECTS } from '../api/ids';
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
];

const [firstLibrary] = LIBRARY_VIDEOS;

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
          'Browse proven videos by category, length and mood; a recommended shelf for the business.',
        scene: 'baker',
        links: [
          {
            href: `#/library/${firstLibrary.id}`,
            label: firstLibrary.title,
            note: 'Blueprint timeline, similar videos, “Use as reference” in TEMPLATE or INSPIRE mode.',
          },
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
          'Every post across platforms: filter by state and platform; retry, cancel or take down.',
        scene: 'storefront',
      },
      {
        title: 'Calendar',
        href: '#/calendar',
        summary: 'Scheduled and published posts on a month grid; an agenda list on phones.',
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
        title: 'Business & images',
        href: '#/business',
        summary: 'Profile, website scan, brand kits and the image library.',
        scene: 'flatlay',
        tryIt: [
          'Profile tab: edit the tone and audience Studio writes with.',
          'Website scan tab: confirm ownership and scan the bakery’s website (progress polls every 3 s).',
          'Brand kits tab: the main kit and a Christmas 2026 kit; set the default.',
          'Image library tab: filter by source, semantic search, generate an image.',
        ],
      },
      {
        title: 'Connections',
        href: '#/connections',
        summary:
          'TikTok, YouTube, LinkedIn and X by OAuth (X needs a reconnect); Instagram and Facebook from PostMind.',
        scene: 'street',
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
        ],
      },
    ],
  },
];

export const BELL_NOTE =
  'The bell in the top bar lists in-app notifications (cost alerts, generation complete, approval waiting, publication failed). Mark one or all as read.';
