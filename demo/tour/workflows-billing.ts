import { PROJECTS } from '../api/ids';
import { projectHref as p, withPlan, type Workflow } from './workflow-types';

// Phase 18 workflows: sign-up to the first video, subscribing, limits and upgrades, a failed
// payment, and cancelling. The payment steps use the demo's own "Demo checkout (simulated)" page
// (no card details, one "Complete demo payment" button); `withPlan` links set the billing state.

const draft = p(PROJECTS.meetTheBakers.id);

export const BILLING_WORKFLOWS: Workflow[] = [
  {
    id: 'signup-first-video',
    title: 'Sign up to the first video',
    outcome:
      'A visitor finds Studio, signs up, sets up the bakery and starts the free Standard trial to generate.',
    area: 'billing',
    scene: 'storefront',
    caption: 'Leeds Sourdough, est. 2019',
    steps: [
      {
        text: 'The real homepage, signed out (where the demo opens): the product story, sample formats and the three-step flow. Press “See pricing”.',
        href: '#/',
        cta: 'Homepage',
      },
      {
        text: 'Compare the plans; flip Monthly / Annual (annual shows the saving). On Standard press “Start free trial”.',
        href: '#/pricing',
        cta: 'Pricing',
      },
      {
        text: 'Sign up as Amara Okafor, amara@leedssourdough.example, with a long password: watch the strength meter, then “Create account”.',
        href: '#/sign-up?plan=STANDARD&interval=month',
        cta: 'Sign up',
      },
      {
        text: '“Check your email”: in the live app the link in the email signs you in. The demo sends nothing: press “Verify (demo) and continue to set-up” under the card.',
        href: '#/verify-email?email=amara%40leedssourdough.example',
        cta: 'Verify email',
      },
      {
        text: 'Onboarding, step 1: name the organisation “Leeds Sourdough Ltd”, country United Kingdom, language, then “Create organisation”. A new organisation has no plan yet (this link sets that too).',
        href: withPlan('#/welcome?new=organisation', 'no_plan'),
        cta: 'Create organisation',
      },
      {
        text: 'Then the business (the sample organisation already has Leeds Sourdough, so it is ticked; a brand-new one is asked to add it), a brand kit from the logo, connect a platform and the first video (“Introduce yourself”). The “Choose a plan” banner stays on top.',
        href: '#/welcome',
        cta: 'Guided setup',
      },
      {
        text: 'Press Generate on a draft: with no plan the server answers 402 plan_required and the upgrade dialog offers “Choose a plan”.',
        href: withPlan(draft, 'no_plan'),
        cta: 'Generate (no plan)',
      },
      {
        text: 'On Billing press “Start free trial” on Standard (14 days, £0 today), then “Complete demo payment” on the simulated checkout: the banner counts down 14 days and Generate works.',
        href: withPlan('#/settings/billing', 'no_plan'),
        cta: 'Start the trial',
      },
    ],
  },
  {
    id: 'start-subscription',
    title: 'Start a subscription',
    outcome: 'An organisation without a plan picks Plus, billed annually, and pays once.',
    area: 'billing',
    scene: 'coffee',
    caption: 'Plus, billed yearly',
    steps: [
      {
        text: 'Pricing: toggle Annual to see the yearly prices and the saving (“Save £418.00 a year” on Standard); the comparison table below lists every limit.',
        href: '#/pricing',
        cta: 'Pricing',
      },
      {
        text: 'Billing without a plan shows the plan picker. Switch its toggle to Annual and press “Choose Plus”.',
        href: withPlan('#/settings/billing', 'no_plan'),
        cta: 'Plan picker',
      },
      {
        text: 'The clearly labelled “Demo checkout (simulated)” page: plan, annual price, no card fields. Press “Complete demo payment”.',
        href: '#/demo-checkout?kind=subscription&tier=PLUS&interval=year',
        cta: 'Demo checkout',
      },
      {
        text: 'Back on Billing: “Your plan is active”, Plus, billed annually, the renewal date, usage meters against the Plus limits.',
        href: '#/settings/billing',
        cta: 'Active plan',
      },
      {
        text: 'Scroll to Invoices: the paid invoices at the plan’s price (PDF links in the live app).',
        href: '#/settings/billing',
        cta: 'Invoices',
      },
      {
        text: 'Plus unlocks voice clone, TEMPLATE mode and AI images: the lock badges are gone on Business → Brand.',
        href: '#/business',
        cta: 'No more locks',
      },
    ],
  },
  {
    id: 'limit-upgrade',
    title: 'Hit a limit and upgrade',
    outcome:
      'A Basic organisation runs out of videos, buys a top-up, then meets a Plus feature and upgrades.',
    area: 'billing',
    scene: 'market',
    caption: '20 of 20 used',
    steps: [
      {
        text: 'On Basic this month’s 20 short videos are used: the usage banner says so with “Upgrade” and “Buy top-up”.',
        href: withPlan('#/projects', 'active_basic'),
        cta: 'Basic, at the limit',
      },
      {
        text: 'Press Generate on the draft: 403 quota_exceeded opens the upgrade dialog with Upgrade or “Buy top-up”.',
        href: draft,
        cta: 'Generate',
      },
      {
        text: '“Buy top-up” (in the dialog or the banner) opens Billing at the top-up packs: press Buy on “10 short videos” (£29), then “Complete demo payment” on the simulated checkout.',
        href: '#/settings/billing#topups',
        cta: 'Buy a top-up',
      },
      {
        text: 'Billing now shows 10 short-video credits; they are used only after the plan’s allowance.',
        href: '#/settings/billing',
        cta: 'Credits shown',
      },
      {
        text: 'Generate again: it runs on a credit (9 left).',
        href: draft,
        cta: 'Generate on a credit',
      },
      {
        text: 'Back on Standard, Business → Brand: Voice profiles carry a “Plus” lock badge. Add a voice: 403 plan_tier names Plus and its price, with Upgrade.',
        href: withPlan('#/business', 'active_standard'),
        cta: 'Locked feature',
      },
      {
        text: 'Upgrade opens the simulated billing portal (the plan is live): “Switch to Plus”. The badge disappears.',
        href: '#/demo-checkout?kind=portal',
        cta: 'Upgrade',
      },
    ],
  },
  {
    id: 'failed-payment',
    title: 'Failed payment and recovery',
    outcome:
      'A card fails: 7 days of grace, then read-only (export still works), then paid and restored.',
    area: 'billing',
    scene: 'street',
    caption: 'Payment needs attention',
    steps: [
      {
        text: 'Past due: the banner says the payment failed and names the grace date; everything still works.',
        href: withPlan('#/projects', 'past_due'),
        cta: 'Past-due banner',
      },
      {
        text: 'Billing: status “Past due” with the days of grace left, and the latest invoice open.',
        href: '#/settings/billing',
        cta: 'Billing',
      },
      {
        text: 'The email owners get (rendered by the real template).',
        href: '#/tour/email/paymentFailed',
        cta: 'Payment-failed email',
      },
      {
        text: 'Grace over: read-only. Press Generate: 402 billing_required and the dialog offers “Update payment method”.',
        href: withPlan(draft, 'read_only'),
        cta: 'Read-only',
      },
      {
        text: 'Export still works while read-only: request an export and download it.',
        href: '#/account/export',
        cta: 'Export data',
      },
      {
        text: 'In the simulated billing portal press “Update payment method”: access is full again and the banner is gone.',
        href: '#/demo-checkout?kind=portal',
        cta: 'Restore access',
      },
    ],
  },
  {
    id: 'cancel-retention',
    title: 'Cancel, data retention and leaving',
    outcome:
      'The owner cancels; the organisation turns read-only, is kept 90 days, then deleted; the account can be deleted too.',
    area: 'billing',
    scene: 'kitchen',
    caption: 'Closing the shop',
    steps: [
      {
        text: 'Billing → “Manage billing” opens the simulated portal. Press “Cancel at period end”: Billing shows “Cancels on …”.',
        href: withPlan('#/demo-checkout?kind=portal', 'active_standard'),
        cta: 'Cancel the plan',
      },
      {
        text: 'The cancellation email.',
        href: '#/tour/email/subscriptionCanceled',
        cta: 'Cancelled email',
      },
      {
        text: 'The period is over: read-only. Changes are refused; export and downloads still work.',
        href: withPlan('#/settings/billing', 'cancelled'),
        cta: 'Read-only',
      },
      {
        text: 'After 90 days read-only the owners get this email, then the organisation is purged.',
        href: '#/tour/email/orgDeletionScheduled',
        cta: '90-day retention email',
      },
      {
        text: 'Delete your account: re-enter the password (fewer than 8 characters is refused as wrong). As the only owner you are asked to transfer ownership first.',
        href: '#/account/security',
        cta: 'Account security',
      },
      {
        text: 'Transfer ownership to Tom Whitaker (password again), then delete the account: you land on the sign-in screen.',
        href: '#/settings/organisation',
        cta: 'Transfer ownership',
      },
    ],
  },
];
