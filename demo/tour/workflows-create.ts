import { LIBRARY_VIDEOS, PROJECTS } from '../api/ids';
import { projectHref as p, withPlan, type Workflow } from './workflow-types';

// Workflows for making videos beyond a plain brief: your own footage, the reference library,
// multi-step approval and outside feedback.

const [, focacciaRef] = LIBRARY_VIDEOS;
const spring = p(PROJECTS.springMenu.id);
export const SHARE_TOKEN = 'demoTokenSpringMenu000000000000000000000000';

export const CREATE_WORKFLOWS: Workflow[] = [
  {
    id: 'upload-video',
    title: 'Upload your own video',
    outcome:
      'Footage shot on a phone becomes captioned, reformatted variants, reviewed and published.',
    area: 'create',
    scene: 'storefront',
    caption: 'Shot on my phone',
    steps: [
      {
        text: 'Create → Options → “Upload a video”, then pick a short MP4, MOV or WebM from your computer: it uploads into this page (nothing leaves it) and shows its length and size.',
        href: '#/new',
        cta: 'Create → Upload',
      },
      {
        text: 'Tick the platforms (TikTok, Reels, Shorts …) and press Generate: no AI footage is bought, the upload is the one shot, and you land on the new project while Studio captions it.',
        href: '#/new',
        cta: 'Formats',
      },
      {
        text: 'Find it again under Projects: captions are written from the speech (Script tab) and each format is cropped from your video.',
        href: '#/projects',
        cta: 'Projects',
      },
      {
        text: 'Review it like any project: play each variant, adjust overlays, approve.',
        href: spring,
        cta: 'Review',
      },
      {
        text: 'Publish tab → “Publish now”; the posts appear in Publications.',
        href: '#/publications',
        cta: 'Publications',
      },
    ],
  },
  {
    id: 'reference-library',
    title: 'Create from the reference library',
    outcome: 'A proven video’s structure (TEMPLATE) or feel (INSPIRE) becomes the bakery’s own.',
    area: 'create',
    scene: 'baker',
    caption: 'Three-step focaccia',
    steps: [
      {
        text: 'Browse by category, length and mood, or search in plain words (“quick recipe with hands in shot”); a recommended shelf for the business.',
        href: '#/library',
        cta: 'Library',
      },
      {
        text: `Open “${focacciaRef.title}”: the blueprint timeline of its beats, similar videos, and “Use as reference”.`,
        href: `#/library/${focacciaRef.id}`,
        cta: 'A reference',
      },
      {
        text: 'INSPIRE mode (included in every plan) borrows the feel; Create shows the reference banner. Press Generate.',
        href: `#/new?reference=${focacciaRef.id}&mode=INSPIRE`,
        cta: 'INSPIRE',
      },
      {
        text: 'TEMPLATE mode copies the structure beat by beat and is not part of the per-channel plan: the Template option carries a “Not in your plan” badge, and Generate opens the dialog saying so (Enterprise is arranged with sales).',
        href: withPlan(`#/new?reference=${focacciaRef.id}&mode=TEMPLATE`, 'active_monthly'),
        cta: 'TEMPLATE (locked)',
      },
      {
        text: 'On Enterprise the same TEMPLATE project goes ahead; a finished one looks like “Our morning ritual”.',
        href: withPlan(`#/new?reference=${focacciaRef.id}&mode=TEMPLATE`, 'enterprise'),
        cta: 'TEMPLATE on Enterprise',
      },
    ],
  },
  {
    id: 'approval',
    title: 'Approval workflow',
    outcome: 'Instagram posts need an admin and then an owner to sign off before they can go out.',
    area: 'create',
    scene: 'croissant',
    caption: 'Two sign-offs',
    steps: [
      {
        text: 'Approval workflows: ordered steps (a role and how many approvers), applied by business, platform or tag; the most specific wins. Create one and reorder its steps.',
        href: '#/approvals',
        cta: 'Approval workflows',
      },
      {
        text: '“Spring menu launch” targets Instagram Reels: the review screen shows “Step 1 of 2 — waiting for admin”. Approve.',
        href: spring,
        cta: 'Step 1',
      },
      {
        text: 'Approve again for step 2 (owner): the project is Approved.',
        href: spring,
        cta: 'Step 2',
      },
      {
        text: 'Publish tab: tick the variants and “Publish now”.',
        href: spring,
        cta: 'Publish',
      },
      {
        text: 'The posts in Publications, and the approvals in the organisation’s audit log.',
        href: '#/settings/audit',
        cta: 'Audit log',
      },
    ],
  },
  {
    id: 'share-feedback',
    title: 'Share for feedback',
    outcome: 'Someone outside the organisation watches the variants and leaves comments.',
    area: 'create',
    scene: 'sourdough',
    caption: 'What do you think?',
    steps: [
      {
        text: 'On the review screen press “Share for feedback”: create a link, see the active links, revoke one.',
        href: spring,
        cta: 'Share for feedback',
      },
      {
        text: 'The public preview the reviewer opens: every variant plays, no sign-in, no approve button (decision P8).',
        href: `#/p/${SHARE_TOKEN}`,
        cta: 'Public preview',
      },
      {
        text: 'Leave a comment with a name (right-to-left text works too) and send it.',
        href: `#/p/${SHARE_TOKEN}`,
        cta: 'Comment',
      },
      {
        text: 'Back in Studio the comment is on the project and in the bell.',
        href: spring,
        cta: 'See the comment',
      },
    ],
  },
];
