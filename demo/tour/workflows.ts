import { LIBRARY_VIDEOS, PROJECTS } from '../api/ids';
import type { SceneKind } from '../media';

// Guided click paths through the demo. Every step links to the screen it happens on; the steps
// name the real buttons and tabs of the Review screen (Variants, Shots, Overlays, Script, Publish;
// Slides for slideshows) and the Admin Centre (Kill switch, Re-drive, Library, Cost report).

export interface WorkflowStep {
  text: string;
  href?: string;
  cta?: string;
}

export interface Workflow {
  id: string;
  title: string;
  outcome: string;
  scene: SceneKind;
  caption: string;
  steps: WorkflowStep[];
}

const p = (id: string) => `#/projects/${id}`;

export const WORKFLOWS: Workflow[] = [
  {
    id: 'brief-to-published',
    title: 'Brief to published video',
    outcome: 'One sentence becomes three platform variants, reviewed and posted.',
    scene: 'sourdough',
    caption: 'Fresh spring loaves',
    steps: [
      {
        text: 'Type a brief such as “Our spring menu: wild garlic focaccia and rhubarb buns” and press Generate.',
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
        text: 'Approve, then open the Publish tab: tick the variants and press “Publish now”, or set a time and Schedule.',
        href: p(PROJECTS.springMenu.id),
        cta: 'Approve & publish',
      },
      {
        text: 'See the post in Publications and on the Calendar, then its numbers in Analytics.',
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
      },
      {
        text: '…or press Force-approve on the variant and give a note (content-safety blocks can never be forced).',
        href: p(PROJECTS.hotCrossBuns.id),
        cta: 'Force-approve',
      },
      { text: 'Approve the project and publish as usual.', href: p(PROJECTS.hotCrossBuns.id) },
    ],
  },
  {
    id: 'slideshow',
    title: 'Build a slideshow',
    outcome: 'A Listicle 5 slideshow from the business’s own photos, with no AI video spend.',
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
      },
      {
        text: 'Edit a slide, add or delete one, and reorder them.',
        href: p(PROJECTS.fiveBakes.id),
      },
      {
        text: 'Check the image library the slides draw from (Image library tab).',
        href: '#/business',
        cta: 'Business & images',
      },
      { text: 'Save the structure as a template for next week.', href: p(PROJECTS.fiveBakes.id) },
    ],
  },
  {
    id: 'overlays',
    title: 'Style overlays',
    outcome:
      'Branded hook, caption and CTA text on the video, previewed and re-rendered without paying for new footage.',
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
      },
      {
        text: 'Drag the timing on the timeline, or use ←/→ (0.1 s) and Shift (0.5 s).',
        href: p(PROJECTS.springMenu.id),
      },
      {
        text: 'Preview the overlay, save it as a preset, bulk-apply to the render, then Re-render.',
        href: p(PROJECTS.springMenu.id),
      },
    ],
  },
  {
    id: 'autopilot',
    title: 'Publish on autopilot',
    outcome:
      'A trusted creator’s clean run is approved and posted with no clicks, on the targets set at creation.',
    scene: 'baker',
    caption: 'Our morning ritual',
    steps: [
      {
        text: `Start from a library reference: “${LIBRARY_VIDEOS[0].title}” in TEMPLATE mode.`,
        href: `#/new?reference=${LIBRARY_VIDEOS[0].id}&mode=TEMPLATE`,
        cta: 'Create from reference',
      },
      {
        text: 'In the options, set Approval to “Approve automatically” and tick “Auto-publish when approved” with one account per platform.',
        href: `#/new?reference=${LIBRARY_VIDEOS[0].id}&mode=TEMPLATE`,
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
    scene: 'studio',
    caption: 'Halt. Release. Re-drive.',
    steps: [
      {
        text: 'Admin Centre → Kill switch: engage a scoped level (workspace, project, provider or one publishing platform) with a reason.',
        href: '#/admin',
        cta: 'Admin Centre',
      },
      { text: 'Global halts everything and asks for typed confirmation.', href: '#/admin' },
      {
        text: 'Release the switch, then Re-drive tab: “Kill-switched work”, Preview the table, Apply.',
        href: '#/admin',
      },
      {
        text: 'A failed post elsewhere is recovered the same way per item: Retry in Publications.',
        href: p(PROJECTS.wholesale.id),
        cta: 'Wholesale for cafés',
      },
      {
        text: 'See what the rehearsal and CLI print, behind the scenes.',
        href: '#/tour/system',
        cta: 'Behind the scenes',
      },
    ],
  },
];
