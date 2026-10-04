import { P17_PROJECTS, P20_PROJECTS, PROJECTS } from '../api/ids';
import type { SceneKind } from '../media';

// #/tour/whats-new — every feature added or changed by Phase 16 (languages + RTL), Phase 18
// (standalone SaaS surfaces), Phase 20.3 (plan a month ahead), 20.9 (plan my month), Phase 17
// (production hardening, 17.1–17.9), Cloudflare R2 storage and the single-server deployment, each
// with a one-line explanation and deep links to the screen or state that shows it. English only,
// like the other tour pages (the Studio screens behind the links follow the language switcher).

export interface SeeIt {
  href: string;
  label: string;
}

export interface WhatsNewItem {
  /** Backlog item, e.g. "17.3". */
  ref: string;
  title: string;
  line: string;
  see: SeeIt[];
}

export interface WhatsNewGroup {
  id: string;
  index: string;
  title: string;
  intro: string;
  scene: SceneKind;
  items: WhatsNewItem[];
}

const project = (id: string) => `#/projects/${id}`;
const system = (section: string) => `#/tour/system?section=${section}`;

export const WHATS_NEW: WhatsNewGroup[] = [
  {
    id: 'phase-16',
    index: '01',
    title: 'Phase 16 — 11 languages and right-to-left',
    intro:
      'Every screen in 11 languages, Arabic mirrored right to left. Use the buttons above, or the language menu in the header.',
    scene: 'street',
    items: [
      {
        ref: '16.1',
        title: 'Language switcher',
        line: 'English (UK and US), French, Spanish, Arabic, German, Italian, Portuguese (Brazil and Portugal), Hindi and Simplified Chinese; the choice is remembered.',
        see: [{ href: '#/projects', label: 'Projects, then the language menu' }],
      },
      {
        ref: '16.2',
        title: 'Right-to-left layout',
        line: 'In Arabic the whole shell mirrors: the menu drawer opens from the start edge and directional icons flip.',
        see: [{ href: project(PROJECTS.springMenu.id), label: 'A review screen in Arabic' }],
      },
      {
        ref: '16.3',
        title: 'Dates, numbers and plurals per language',
        line: 'Dates, durations and counts follow the language, including Arabic’s six plural forms; money stays in pounds.',
        see: [
          { href: '#/analytics', label: 'Analytics' },
          { href: '#/calendar', label: 'Calendar' },
        ],
      },
      {
        ref: '16.5',
        title: 'Notifications in the reader’s language',
        line: 'The bell renders each notification from its message key, including cost alerts, safety reviews and plan quotas; a row written before 16.5 shows its stored English.',
        see: [{ href: '#/projects', label: 'Open the bell in the header' }],
      },
    ],
  },
  {
    id: 'phase-17',
    index: '02',
    title: 'Phase 17 — production hardening',
    intro:
      'The runbook GAPs that were code, closed; and server-written text now shown in the reader’s language.',
    scene: 'studio',
    items: [
      {
        ref: '17.1',
        title: 'Abandoned uploads swept',
        line: 'A daily job deletes uploads that were never finished after a 24-hour grace period, and never touches one that is still in use.',
        see: [{ href: system('reliability'), label: 'Sample run' }],
      },
      {
        ref: '17.2',
        title: 'Lost scheduled posts re-driven',
        line: 'Every 10 minutes, a scheduled post whose publish job was lost in a crash is enqueued again, once. Staff see it in the audit log; customers see the post go out.',
        see: [{ href: system('reliability'), label: 'Sample run and skip reasons' }],
      },
      {
        ref: '17.3',
        title: 'Daily account check',
        line: 'Each connected account is checked once a day: healthy ones show “Access checked”, a refused one asks to be reconnected and notifies its owner.',
        see: [
          { href: '#/connections', label: 'Connections (X needs reconnecting)' },
          { href: '#/connections', label: 'The bell: “Reconnect your X account”' },
        ],
      },
      {
        ref: '17.4',
        title: 'Provider failover alert',
        line: 'A ticket when more than 20% of routings pass a provider over for 10 minutes, next to the breaker-open alert.',
        see: [{ href: system('failover'), label: 'Rule and sample metrics' }],
      },
      {
        ref: '17.5',
        title: 'Object-storage backup',
        line: 'A nightly copy of the assets, renders and thumbnails buckets into one backup bucket; copies of deleted files go after 30 days, so purged data ages out.',
        see: [{ href: system('backup'), label: 'Sample nightly report' }],
      },
      {
        ref: '17.6',
        title: 'Upload URLs sign the file type',
        line: 'Browser upload links on S3 now sign Content-Type and carry no empty-body checksum, as on R2.',
        see: [{ href: system('storage'), label: 'Storage settings' }],
      },
      {
        ref: '17.7',
        title: 'CI matches production',
        line: 'The database tests run on Postgres 17 with pgvector, and CI builds the monitoring image and checks its binaries and rules.',
        see: [{ href: system('alerts'), label: 'Alert rules CI tests' }],
      },
      {
        ref: '17.8',
        title: 'Ownership statement recorded with its language',
        line: 'The website scan sends {locale, messageKey, text}; the server stores the approved wording for that language and refuses any other text.',
        see: [
          { href: '#/business', label: 'Business → Website scan' },
          { href: '#/tour/whats-new?section=statement', label: 'Try a tampered statement (below)' },
        ],
      },
      {
        ref: '17.9',
        title: 'Failure reasons in the reader’s language',
        line: 'Stored reasons keep a stable code; the screens translate it and show only a provider’s own message untranslated.',
        see: [
          {
            href: project(P17_PROJECTS.easterWindow.id),
            label: 'Kill switch inside a planning failure',
          },
          {
            href: project(P17_PROJECTS.gardenBakes.id),
            label: 'Shots 2 and 4 failed (Shots tab: each provider error)',
          },
          { href: project(P17_PROJECTS.knifeSkills.id), label: 'Content-safety block' },
          {
            href: project(PROJECTS.morningRitual.id),
            label: 'YouTube quota: retried after the reset (Publish tab)',
          },
          {
            href: '#/publications',
            label: 'Publications: platform kill switch, rate limit, reconnect',
          },
          { href: project(PROJECTS.hotCrossBuns.id), label: 'Quality check details with numbers' },
        ],
      },
      {
        ref: '17.9',
        title: '“Untitled video” is never stored',
        line: 'A project without a name has none; lists, review and notifications show “Untitled video” in the reader’s language.',
        see: [
          { href: '#/projects', label: 'Projects list' },
          { href: project(P17_PROJECTS.untitled.id), label: 'Its review screen (quality details)' },
        ],
      },
      {
        ref: '17.9',
        title: 'Every template category translated',
        line: 'Listicle, Listicle 5, Listicle 10 and the other categories have labels in every language.',
        see: [
          { href: '#/templates', label: 'Templates' },
          { href: '#/new', label: 'Create → Options → Slideshow (picker)' },
        ],
      },
    ],
  },
  {
    id: 'storage',
    index: '03',
    title: 'Storage — Cloudflare R2',
    intro: 'Files live in Cloudflare R2 in the EU jurisdiction; encryption keys stay in AWS KMS.',
    scene: 'flatlay',
    items: [
      {
        ref: 'R2',
        title: 'R2 as the object store',
        line: 'STORAGE_PROVIDER=r2 with the EU endpoint, four buckets and a separate backup bucket; S3 still works.',
        see: [{ href: system('storage'), label: 'Buckets and settings' }],
      },
      {
        ref: 'R2',
        title: 'Lifecycle without tags',
        line: 'R2 has no object tags, so provider outputs go under intermediates/ and expire by prefix after 30 days.',
        see: [{ href: system('storage'), label: 'Lifecycle rules' }],
      },
      {
        ref: 'R2',
        title: 'What people still need to do',
        line: 'Create the buckets, CORS and tokens, including the backup bucket and its own token.',
        see: [{ href: '#/tour/not-built', label: 'Not built: R2 buckets' }],
      },
    ],
  },
  {
    id: 'deployment',
    index: '04',
    title: 'Deployment — one server in Germany',
    intro:
      'Studio runs on a single Hetzner VPS: Caddy for TLS, the web app, one worker process for all six queues, Postgres 17 + pgvector, Redis, Prometheus and Alertmanager, and nightly backups to R2. Cost: one server, priced on Hetzner’s site.',
    scene: 'storefront',
    items: [
      {
        ref: 'VPS',
        title: 'Single-server topology',
        line: 'Everything in one Docker Compose stack, deployed by scripts/vps/deploy.sh; files in R2 (EU), keys in AWS KMS.',
        see: [{ href: system('deploy'), label: 'Topology' }],
      },
      {
        ref: 'VPS',
        title: 'Nightly backups',
        line: 'The database and the object storage are backed up every night to the R2 backup bucket.',
        see: [{ href: system('backup'), label: 'Storage backup report' }],
      },
      {
        ref: 'VPS',
        title: 'What people still need to do',
        line: 'Rent the server, run the setup script and fill in the secrets (runbooks/vps-deploy.md); add the PagerDuty key and Slack webhook.',
        see: [{ href: '#/tour/not-built', label: 'Not built: Hetzner server, alert routing' }],
      },
    ],
  },
  {
    id: 'phase-18',
    index: '05',
    title: 'Phase 18 — Studio as its own product',
    intro:
      'Studio no longer needs PostMind Core: a public site, its own sign-up and sign-in, organisations with members and roles, an audit log, Stripe plans and billing, and a staff console.',
    scene: 'storefront',
    items: [
      {
        ref: '18.E1',
        title: 'Landing page',
        line: 'The public home page tells the story for small businesses and links to sign-up and pricing.',
        see: [{ href: '#/landing', label: 'Landing page' }],
      },
      {
        ref: '18.E2',
        title: 'Legal pages and the launch gate',
        line: 'Six legal documents from the operator’s Markdown; while terms or privacy is a placeholder, production sign-up stays closed and staff see a warning.',
        see: [
          { href: '#/legal/privacy', label: 'Privacy policy (placeholder)' },
          { href: '#/admin', label: 'Admin warning' },
        ],
      },
      {
        ref: '18.E3',
        title: 'Guided setup from zero',
        line: 'Create the organisation, add the first business, then brand kit, connect and first video.',
        see: [{ href: '#/welcome?new=organisation', label: 'Create an organisation' }],
      },
      {
        ref: '18.E4',
        title: 'Organisation, members and audit log',
        line: 'Rename, transfer ownership or delete the organisation; invite members with roles and a seat meter; see who changed what.',
        see: [
          { href: '#/settings/organisation', label: 'Organisation settings' },
          { href: '#/settings/members', label: 'Members' },
          { href: '#/settings/audit', label: 'Audit log' },
        ],
      },
      {
        ref: '18.E5',
        title: 'Staff console for the business',
        line: 'Search organisations and users, ban, sign out or reset 2FA with a reason, read subscriptions; impersonation is off by default.',
        see: [
          { href: '#/admin?tab=organisations', label: 'Organisations' },
          { href: '#/admin?tab=users', label: 'Users' },
          { href: '#/admin?tab=subscriptions', label: 'Subscriptions' },
        ],
      },
      {
        ref: '18.E6',
        title: 'Organisation switcher, user menu and banners',
        line: 'Switch organisation and sign out from the header; banners show a trial, a failed payment, read-only access or staff view.',
        see: [{ href: '#/projects', label: 'Any screen: the header and the trial banner' }],
      },
    ],
  },
  {
    id: 'phase-20',
    index: '06',
    title: 'Phase 20 — Plan a month ahead',
    intro:
      'Videos can be auto-scheduled up to a month and more ahead: one-click posting plans, open posting times on the calendar, and an honest notice when there is no free time.',
    scene: 'baker',
    items: [
      {
        ref: '20.3',
        title: 'Posting plans in one click',
        line: '“3 a week”, “5 a week” or “Every day” fill the drip queue’s posting times in your time zone; edit any of them, then save.',
        see: [
          { href: '#/calendar', label: 'Calendar: the drip queue panel' },
          { href: '#/welcome', label: 'Onboarding: “Plan your month”' },
        ],
      },
      {
        ref: '20.3',
        title: 'Open posting times on the calendar',
        line: 'Dashed markers show the free drip-queue times for the month ahead, and a line above the grid counts posts scheduled and open slots in the next 30 days.',
        see: [{ href: '#/calendar', label: 'Calendar' }],
      },
      {
        ref: '20.3',
        title: 'Schedule into the next free slot',
        line: 'Create a video with “No date — use the next free drip-queue slot”; if none is free within 8 weeks the Review screen says so, and “Try again” schedules it once there is room.',
        see: [
          { href: '#/new', label: 'Create: Advanced options' },
          { href: project(P20_PROJECTS.harvestLoaf.id), label: 'A video waiting for a free slot' },
        ],
      },
      {
        ref: '20.3',
        title: 'Scheduling limits you can see',
        line: 'Date pickers stop at 180 days ahead and explain why before anything is sent.',
        see: [{ href: project(PROJECTS.springMenu.id), label: 'Review: the Publish tab' }],
      },
      {
        ref: '20.9',
        title: 'Plan my month',
        line: 'Pick the dates, 1 to 4 posts a day (or your posting times) and the video / slideshow mix; Claude drafts a varied month from your website, brand kit, past posts and UK calendar days, within your allowance. Edit the list, then “Generate and schedule”.',
        see: [
          { href: '#/plans/new', label: 'Plan my month' },
          { href: '#/calendar', label: 'Calendar: “Plan my month”' },
        ],
      },
      {
        ref: '20.9',
        title: 'Auto-post with a review window',
        line: 'Every post is made and scheduled at its own time, and publishes unless you swap or remove it first; posts the safety check holds are never published, and you get one summary email.',
        see: [
          { href: '#/plans/plan-october', label: 'A plan half made (one post held)' },
          { href: '#/calendar', label: 'Calendar: “Planned” posts' },
          { href: '#/tour/email/monthPlanned', label: 'The summary email' },
        ],
      },
      {
        ref: '20.13',
        title: 'Captions and at least five hashtags on every post',
        line: 'Every generated video and slideshow gets a caption per platform and at least five hashtags: your business hashtag first (from your business name, editable), your “always include” hashtags, then suggestions from your business profile, the post and UK calendar days. Suggestions are labelled “Suggested”: no platform gives Studio trend data, so nothing is called trending.',
        see: [
          { href: '#/business?tab=hashtags', label: 'Business: Hashtags' },
          {
            href: project(PROJECTS.springMenu.id),
            label: 'Review: edit caption and hashtag chips',
          },
          { href: '#/plans/plan-october', label: 'Plan: a post’s caption and hashtags' },
          { href: '#/publications', label: 'Publications with their hashtags' },
        ],
      },
      {
        ref: '20.27',
        title: 'Staff change a plan, access or cost caps, and end a trial',
        line: 'Admin Centre → Organisations lists each organisation’s plan, access, trial and AI cost this month. Open one: “Plan, access and trial” sits beside Cost caps, with the trial’s AI cost against its £15 cap, an override form (tier, access, expiry, reason, “End the trial now”, with a confirmation) and Remove override. Cost caps gain “Clear back to plan default”.',
        see: [
          {
            href: '#/admin?tab=organisations',
            label: 'Admin: Organisations (open “PostMind (operator)”)',
          },
        ],
      },
    ],
  },
  {
    id: 'phase-21',
    index: '07',
    title: 'Phase 21 — UGC actor videos',
    intro:
      'A generated creator talks to camera about your product, like a review filmed on a phone. The actor speaks every line with lips in sync; there is no separate voice-over.',
    scene: 'kitchen',
    items: [
      {
        ref: '21.4',
        title: 'UGC actor on Create',
        line: 'Create → Options → “UGC actor”: optionally name the product, pick its photo from your image library and choose the actor’s age, person and setting. A UGC video uses 2 of your videos. Briefs that ask for a real person or celebrity are refused.',
        see: [{ href: '#/new', label: 'Create: Options, then “UGC actor”' }],
      },
      {
        ref: '21.4',
        title: 'A UGC video ready for review',
        line: 'Three actor clips (the same generated person each time), a product still and an end card, captioned from what the actor says, with the AI-generated label on.',
        see: [
          { href: project(PROJECTS.ugcReview.id), label: 'Review: Creator review: the bread box' },
        ],
      },
      {
        ref: '21.4',
        title: 'UGC in Plan my month',
        line: 'Tick “Make testimonial and product videos with UGC actors” and the plan’s testimonial and product videos are made with actors.',
        see: [{ href: '#/plans/new', label: 'Plan my month' }],
      },
    ],
  },
];
