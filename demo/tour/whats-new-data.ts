import { P17_PROJECTS, PROJECTS } from '../api/ids';
import type { SceneKind } from '../media';

// #/tour/whats-new — every feature added or changed by Phase 16 (languages + RTL), Phase 17
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
];
