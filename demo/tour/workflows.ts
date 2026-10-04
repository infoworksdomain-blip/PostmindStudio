import { LIBRARY_VIDEOS, PROJECTS } from '../api/ids';
import { projectHref as p, withPlan, type Workflow } from './workflow-types';
import { BILLING_WORKFLOWS } from './workflows-billing';
import { OPERATE_WORKFLOWS, TEAM_WORKFLOWS } from './workflows-team';
import { CREATE_WORKFLOWS } from './workflows-create';

// Guided click paths through the demo. Every step links to the screen it happens on; the steps
// name the real buttons and tabs (Review: Variants, Shots, Overlays, Script, Publish; Slides for
// slideshows; Admin Centre tabs) and use the sample data (Leeds Sourdough, fictional).

export type { Workflow, WorkflowStep } from './workflow-types';

const [ritualRef] = LIBRARY_VIDEOS;

/** The original six (Phases 1–15), updated for the Phase 18 plans. */
const CORE_WORKFLOWS: Workflow[] = [
  {
    id: 'brief-to-published',
    title: 'Brief to published video',
    outcome: 'One sentence becomes three platform variants, reviewed and posted.',
    area: 'create',
    scene: 'sourdough',
    caption: 'Fresh spring loaves',
    steps: [
      {
        text: 'Type a brief such as “Our spring menu: wild garlic focaccia and rhubarb buns” and press Generate (Ctrl/Cmd+Enter).',
        href: '#/new',
        cta: 'Create',
      },
      {
        text: 'Watch the pipeline strip advance through planning, assets, composition and quality checks.',
        href: p(PROJECTS.loyaltyCard.id),
        cta: 'A live render',
      },
      {
        text: 'Open a finished project: play each variant, check the Shots and Script tabs.',
        href: p(PROJECTS.springMenu.id),
        cta: 'Spring menu launch',
      },
      {
        text: 'Approve (two steps: this project has an approval workflow), then the Publish tab: tick the variants and press “Publish now”, or set a time and Schedule.',
        href: p(PROJECTS.springMenu.id),
        cta: 'Approve & publish',
      },
      {
        text: 'See the posts in Publications and on the Calendar, then their numbers in Analytics.',
        href: '#/publications',
        cta: 'Publications',
      },
    ],
  },
  {
    id: 'quality-failed',
    title: 'Fix a failed quality check',
    outcome:
      'A render that failed the loudness check goes out after a deliberate, recorded override.',
    area: 'create',
    scene: 'cake',
    caption: 'Hot cross buns are back',
    steps: [
      {
        text: 'Open the project: the quality panel shows loudness outside −18…−10 LUFS in red; open it for the detail.',
        href: p(PROJECTS.hotCrossBuns.id),
        cta: 'Hot cross buns',
      },
      {
        text: 'Either regenerate the offending shot from the Shots tab (with a prompt override)…',
        href: p(PROJECTS.hotCrossBuns.id),
        cta: 'Shots tab',
      },
      {
        text: '…or press Force-approve on the variant and give a note (content-safety blocks can never be forced).',
        href: p(PROJECTS.hotCrossBuns.id),
        cta: 'Force-approve',
      },
      {
        text: 'Staff see the override, the note and the failed checks in Admin → Force-approvals.',
        href: '#/admin?tab=force-approvals',
        cta: 'Force-approvals',
      },
    ],
  },
  {
    id: 'slideshow',
    title: 'Build a slideshow',
    outcome: 'A Listicle 5 slideshow from the business’s own photos, with no AI video spend.',
    area: 'create',
    scene: 'flatlay',
    caption: '5 bakes to try',
    steps: [
      {
        text: 'Open the slideshow project and its Slides tab.',
        href: p(PROJECTS.fiveBakes.id),
        cta: '5 bakes',
      },
      {
        text: 'Press Auto-populate: text is written from the topic and images are matched from the image library (gaps generated).',
        href: p(PROJECTS.fiveBakes.id),
        cta: 'Auto-populate',
      },
      {
        text: 'Edit a slide, add or delete one, and reorder them.',
        href: p(PROJECTS.fiveBakes.id),
        cta: 'Slides tab',
      },
      {
        text: 'Check the image library the slides draw from (Image library tab).',
        href: '#/business',
        cta: 'Business & images',
      },
      {
        text: 'Save the structure as a template (included in every plan), then find it under Templates.',
        href: '#/templates',
        cta: 'Templates',
      },
    ],
  },
  {
    id: 'overlays',
    title: 'Style overlays',
    outcome:
      'Branded hook, caption and CTA text on the video, previewed and re-rendered without paying for new footage.',
    area: 'create',
    scene: 'croissant',
    caption: 'Butter. Layers. 5am.',
    steps: [
      {
        text: 'Open a project in review and its Overlays tab.',
        href: p(PROJECTS.springMenu.id),
        cta: 'Spring menu launch',
      },
      {
        text: 'Pick a preset (Hook, Subtitle, CTA, Quote, Statistic, Story, Brand), then adjust font, colour and position; the layout frame matches the variant’s aspect ratio.',
        href: p(PROJECTS.springMenu.id),
        cta: 'Overlays tab',
      },
      {
        text: 'Drag the timing on the timeline, or use ←/→ (0.1 s) and Shift (0.5 s).',
        href: p(PROJECTS.springMenu.id),
        cta: 'Timeline',
      },
      {
        text: 'Preview the overlay, save it as a preset, bulk-apply to the render, then Re-render.',
        href: p(PROJECTS.springMenu.id),
        cta: 'Re-render',
      },
    ],
  },
  {
    id: 'autopilot',
    title: 'Publish on autopilot',
    outcome:
      'A trusted creator’s clean run is approved and posted with no clicks, on the targets set at creation.',
    area: 'create',
    scene: 'baker',
    caption: 'Our morning ritual',
    steps: [
      {
        text: `Start from a library reference: “${ritualRef.title}” in TEMPLATE mode. TEMPLATE is not part of the per-channel plan (Enterprise only), so this link switches the demo to Enterprise.`,
        href: withPlan(`#/new?reference=${ritualRef.id}&mode=TEMPLATE`, 'enterprise'),
        cta: 'Create from reference',
      },
      {
        text: 'In the options, set Approval to “Approve automatically” and tick “Auto-publish when approved” with one account per platform.',
        href: `#/new?reference=${ritualRef.id}&mode=TEMPLATE`,
        cta: 'Options',
      },
      {
        text: 'See the result: approved automatically (creator has ≥ 10 human-approved projects, clean run, not ENTERPRISE), with per-target outcomes.',
        href: p(PROJECTS.morningRitual.id),
        cta: 'Our morning ritual',
      },
      { text: 'The scheduled posts appear on the Calendar.', href: '#/calendar', cta: 'Calendar' },
    ],
  },
  {
    id: 'kill-switch',
    title: 'Kill switch and recovery',
    outcome: 'Stop work at the right blast radius, then resume exactly what was stopped, once.',
    area: 'operate',
    scene: 'studio',
    caption: 'Halt. Release. Re-drive.',
    steps: [
      {
        text: 'Admin Centre → Kill switch: engage a scoped level (workspace, project, provider or one publishing platform) with a reason.',
        href: '#/admin?tab=kill-switch',
        cta: 'Kill switch',
      },
      {
        text: 'Global halts everything and waits for a second staff member (typed confirmation).',
        href: '#/admin?tab=kill-switch',
        cta: 'Global',
      },
      {
        text: 'Release the switch, then Re-drive tab: “Kill-switched work”, Preview the table, Apply.',
        href: '#/admin?tab=redrive',
        cta: 'Re-drive',
      },
      {
        text: 'A failed post elsewhere is recovered the same way per item: Retry in Publications.',
        href: p(PROJECTS.wholesale.id),
        cta: 'Wholesale for cafés',
      },
      {
        text: 'See what the rehearsal and CLI print, behind the scenes.',
        href: '#/tour/system?section=kill-switch',
        cta: 'Behind the scenes',
      },
    ],
  },
];

export const WORKFLOW_AREAS: Array<{ key: Workflow['area']; label: string; intro: string }> = [
  {
    key: 'billing',
    label: 'Sign-up, plans and billing',
    intro: 'From the landing page to a paying customer, and every state a subscription can be in.',
  },
  {
    key: 'create',
    label: 'Make and publish',
    intro: 'Briefs, uploads, the reference library, slideshows, overlays, review and publishing.',
  },
  {
    key: 'team',
    label: 'Team, accounts and languages',
    intro: 'Members and roles, connected platforms, brand voice, languages, leaving.',
  },
  {
    key: 'operate',
    label: 'Run the platform',
    intro: 'The staff console, kill switch and the reliability jobs behind it.',
  },
];

const ALL: Workflow[] = [
  ...BILLING_WORKFLOWS,
  ...CORE_WORKFLOWS,
  ...CREATE_WORKFLOWS,
  ...TEAM_WORKFLOWS,
  ...OPERATE_WORKFLOWS,
];

/** Every workflow, in the order the Workflows page shows them (by area). */
export const WORKFLOWS: Workflow[] = WORKFLOW_AREAS.flatMap((a) =>
  ALL.filter((f) => f.area === a.key),
);
