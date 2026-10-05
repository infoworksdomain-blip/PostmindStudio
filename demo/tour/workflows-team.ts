import { PROJECTS } from '../api/ids';
import { PRICE_TEXT } from './price-text';
import { projectHref as p, withLang, withPlan, type Workflow } from './workflow-types';

// Workflows for the team and the account (members, connections, brand voice, languages) and for
// running the platform (the staff console and the reliability jobs).

export const TEAM_WORKFLOWS: Workflow[] = [
  {
    id: 'invite-teammate',
    title: 'Invite a teammate',
    outcome:
      'A new publisher joins within the plan’s seats; roles change; the last owner is protected.',
    area: 'team',
    scene: 'baker',
    caption: 'Welcome, Jo',
    steps: [
      {
        text: 'Members: the plan has 5 seats; 4 people and Sam’s pending invitation use them all, so the invite form is off and the seat meter says every seat is in use.',
        href: withPlan('#/settings/members', 'active_monthly'),
        cta: 'Members',
      },
      {
        text: 'Revoke Sam’s invitation (4 of 5), then invite jo@leedssourdough.example as Publisher: sent, and the plan is full again.',
        href: '#/settings/members',
        cta: 'Invite',
      },
      {
        text: 'The invitation email Jo receives.',
        href: '#/tour/email/invite',
        cta: 'Invitation email',
      },
      {
        text: 'What an invitee sees: the organisation and role, then Accept (lands in Projects, still inside the demo).',
        href: '#/invite/inv-demo',
        cta: 'Accept an invite',
      },
      {
        text: 'Change Leo from Creator to Viewer. Then try to make yourself Admin: you are the only owner, so it is refused (last-owner protection).',
        href: '#/settings/members',
        cta: 'Roles',
      },
      {
        text: 'Every channel plan has 5 seats; more are arranged with sales (Enterprise, 40 seats here), so the invite form opens again.',
        href: withPlan('#/settings/members', 'enterprise'),
        cta: 'More seats',
      },
    ],
  },
  {
    id: 'connect-accounts',
    title: 'Connect social accounts',
    outcome:
      'TikTok, YouTube, LinkedIn and X by OAuth, Facebook and Instagram through Studio’s own Facebook login.',
    area: 'team',
    scene: 'street',
    caption: 'Connected everywhere',
    steps: [
      {
        text: 'Connections: each account with “Access checked <date>” from the daily check.',
        href: '#/connections',
        cta: 'Connections',
      },
      {
        text: 'Channels: the plan pays for 3, so the platforms connected first (TikTok, Instagram, YouTube) publish; Facebook, X and LinkedIn stay connected but show “add a channel”. Publishing to one of them opens “Add a channel to publish here”.',
        href: '#/connections',
        cta: 'Channel limit',
      },
      {
        text: 'Connect TikTok (or YouTube, LinkedIn): the demo’s OAuth round trip comes straight back with the “connected” notice.',
        href: '#/connections',
        cta: 'Connect TikTok',
      },
      {
        text: '“Connect with Facebook” (Facebook Login for Business, simulated): the Pages and linked Instagram accounts come back connected by Studio.',
        href: '#/connections',
        cta: 'Connect with Facebook',
      },
      {
        text: 'X refused the daily check: it says “Reconnect”, and the bell has “Reconnect your X account”. Reconnect it.',
        href: '#/connections',
        cta: 'Reconnect X',
      },
      {
        text: 'Create pre-selects platforms from the connected accounts.',
        href: '#/new',
        cta: 'Create',
      },
    ],
  },
  {
    id: 'brand-voice',
    title: 'Brand voice',
    outcome: 'The owner clones her own voice, with recorded consent, for narration (Enterprise).',
    area: 'team',
    scene: 'studio',
    caption: 'In Amara’s voice',
    steps: [
      {
        text: 'Business → Brand tab → Voice profiles: voice cloning is not part of the per-channel plan, so the heading carries a “Not in your plan” badge.',
        href: withPlan('#/business', 'active_monthly'),
        cta: 'Voice (locked)',
      },
      {
        text: 'Try “Add voice” anyway: the server answers 403 plan_tier and the dialog says it is not included in your plan.',
        href: '#/business',
        cta: 'Blocked',
      },
      {
        text: 'On Enterprise: name the voice, record the speaker reading the consent statement, add 1–5 samples, tick consent and save.',
        href: withPlan('#/business', 'enterprise'),
        cta: 'Clone on Enterprise',
      },
      {
        text: 'Preview the voice with a line of text; set it on a brand kit so narration uses it.',
        href: '#/business',
        cta: 'Preview',
      },
    ],
  },
  {
    id: 'languages',
    title: 'Languages',
    outcome:
      'The whole interface in 11 languages: Arabic right to left, Chinese, and emails in the reader’s language.',
    area: 'team',
    scene: 'market',
    caption: 'مرحبا · 你好',
    steps: [
      {
        text: 'Arabic: the layout mirrors (menu on the right, arrows flipped), dates and numbers are Arabic.',
        href: withLang('#/projects', 'ar'),
        cta: 'Arabic',
      },
      {
        text: 'A review screen in Arabic, failure reasons included.',
        href: withLang(p(PROJECTS.hotCrossBuns.id), 'ar'),
        cta: 'Review in Arabic',
      },
      {
        text: 'Chinese (Simplified): billing with prices in GBP formatted for the locale.',
        href: withLang('#/settings/billing', 'zh-Hans'),
        cta: 'Chinese',
      },
      {
        text: 'Emails follow the reader’s language too (this one in Chinese).',
        href: withLang('#/tour/email/trialEnding', 'zh-Hans'),
        cta: 'Email in Chinese',
      },
      {
        text: 'Back to British English (or pick any of the 11 in the header).',
        href: withLang('#/projects', 'en-GB'),
        cta: 'English',
      },
    ],
  },
];

export const OPERATE_WORKFLOWS: Workflow[] = [
  {
    id: 'admin',
    title: 'Admin: run the business',
    outcome:
      'Staff find any organisation or user, read MRR, set an Enterprise deal safely and keep the platform in check.',
    area: 'operate',
    scene: 'studio',
    caption: 'Staff console',
    steps: [
      {
        text: 'Organisations: search, plan, status, members, cost this month; open Bramley Florist (past due).',
        href: '#/admin?tab=organisations',
        cta: 'Organisations',
      },
      {
        text: 'Users: open Priya, reset her two-step verification or ban a spam account with a reason (audited; staff accounts are refused).',
        href: '#/admin?tab=users',
        cta: 'Users',
      },
      {
        text: `Billing: MRR by tier and status. Under Entitlements type org-leeds-sourdough, choose Enterprise: a price under ${PRICE_TEXT.enterpriseMinimum} (the minimum for a ${PRICE_TEXT.enterpriseCap} cost cap) is refused; ${PRICE_TEXT.enterpriseList} saves and the demo switches to Enterprise.`,
        href: '#/admin?tab=billing',
        cta: 'MRR & Enterprise',
      },
      {
        text: 'Subscriptions: every status with past-due grace dates.',
        href: '#/admin?tab=subscriptions',
        cta: 'Subscriptions',
      },
      {
        text: 'Cost report: today’s caps, the top organisations, projects over 80% of budget.',
        href: '#/admin?tab=cost',
        cta: 'Cost caps',
      },
      {
        text: 'Kill switch: engage a scoped level with a reason; global waits for a second person.',
        href: '#/admin?tab=kill-switch',
        cta: 'Kill switch',
      },
      {
        text: 'Beta: cohorts, “Plus for 30 days”, and feedback.',
        href: '#/admin?tab=beta',
        cta: 'Beta',
      },
      {
        text: 'Safety audit: a sample of passed videos re-checked by people.',
        href: '#/admin?tab=safety-audit',
        cta: 'Safety audit',
      },
    ],
  },
  {
    id: 'reliability',
    title: 'Reliability, behind the scenes',
    outcome:
      'Lost posts re-driven, accounts checked daily, providers failed over and storage backed up, with no one watching.',
    area: 'operate',
    scene: 'coffee',
    caption: 'Nothing lost',
    steps: [
      {
        text: 'Reliability jobs: the log lines of a lost scheduled post re-driven once, the daily account check and the abandoned-upload sweep.',
        href: '#/tour/system?section=reliability',
        cta: 'Reliability jobs',
      },
      {
        text: 'In Publications: a post held by a platform kill switch, one deferred for YouTube quota, one rate-limited, each with its reason translated.',
        href: '#/publications',
        cta: 'Publications',
      },
      {
        text: 'The account check’s result on Connections (“Access checked”, X refused).',
        href: '#/connections',
        cta: 'Account check',
      },
      {
        text: 'Storage backup: the report of the nightly copy and the 30-day tombstones.',
        href: '#/tour/system?section=backup',
        cta: 'Backups',
      },
      {
        text: 'Dead letters and bulk re-drive in the Admin Centre.',
        href: '#/admin?tab=dead-letters',
        cta: 'Dead letters',
      },
    ],
  },
];
