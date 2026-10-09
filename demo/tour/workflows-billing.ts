import { PROJECTS } from '../api/ids';
import { PRICE_TEXT } from './price-text';
import { projectHref as p, withPlan, type Workflow } from './workflow-types';

// Phase 18 / 26.1 workflows: sign-up to the first video, subscribing, using up the videos (video
// packs, a bigger plan), changing the plan (upgrade now, downgrade at the end of the period), a
// failed payment, and cancelling. Three plans, Starter / Growth / Pro, each posting to every
// platform (plans.ts). The payment steps use the demo's own "Demo checkout
// (simulated)" page (no card details, one "Complete demo payment" button); `withPlan` links set
// the billing state.

const draft = p(PROJECTS.meetTheBakers.id);

export const BILLING_WORKFLOWS: Workflow[] = [
  {
    id: 'signup-first-video',
    title: 'Sign up to the first video',
    outcome:
      'A visitor finds Studio, picks a plan, signs up, sets up the bakery and starts the free trial to generate.',
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
        text: `Three plans, each posting to every platform: choose Growth (most popular) and Monthly (${PRICE_TEXT.growthMonthly} a month, 20 HD videos, 3 seats), then press “Start free trial”.`,
        href: '#/pricing',
        cta: 'Pricing',
      },
      {
        text: 'Sign up as Amara Okafor, amara@leedssourdough.example, with a long password: watch the strength meter, then “Create account”.',
        href: '#/sign-up?next=%2Fsettings%2Fbilling%3Fplan%3Dgrowth%26interval%3Dmonth',
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
        text: 'On Your plan choose Growth, Monthly, and press “Start free trial” (7 days with 2 HD videos, £0 today), then “Complete demo payment” on the simulated checkout: the banner counts down 7 days and Generate works.',
        href: withPlan('#/settings/billing?plan=growth&interval=month', 'no_plan'),
        cta: 'Start the trial',
      },
    ],
  },
  {
    id: 'start-subscription',
    title: 'Start a subscription',
    outcome:
      'A returning organisation (its trial already used) picks Pro, billed yearly, and pays once upfront.',
    area: 'billing',
    scene: 'coffee',
    caption: 'Pro, yearly',
    steps: [
      {
        text: `Pricing: switch to Yearly (Growth ${PRICE_TEXT.growthYearly}, Pro ${PRICE_TEXT.proYearly}, paid upfront: 2 months free) and Weekly (Growth ${PRICE_TEXT.growthWeekly} a week, dearer over a month). The video packs and the questions are below.`,
        href: '#/pricing',
        cta: 'Pricing',
      },
      {
        text: 'Your plan after an earlier plan ended shows the plan picker. Choose Pro and Yearly, then “Continue to payment”.',
        href: withPlan('#/settings/billing', 'cancelled'),
        cta: 'Plan picker',
      },
      {
        text: 'The clearly labelled “Demo checkout (simulated)” page: Pro, the yearly price, 45 HD videos a month, 3 businesses and 10 seats, no card fields. Press “Complete demo payment”.',
        href: '#/demo-checkout?kind=plan&plan=pro&interval=year',
        cta: 'Demo checkout',
      },
      {
        text: 'Back on Your plan: Pro, yearly, the renewal date, and 45 videos this month (released each month).',
        href: '#/settings/billing',
        cta: 'Active plan',
      },
      {
        text: 'Connections: all six connected platforms publish, as on every plan.',
        href: '#/connections',
        cta: 'Every platform publishes',
      },
      {
        text: 'Scroll to Invoices: the paid invoice at the plan’s price (PDF links in the live app).',
        href: '#/settings/billing',
        cta: 'Invoices',
      },
    ],
  },
  {
    id: 'limit-upgrade',
    title: 'Use up the videos, buy a pack, move up a plan',
    outcome:
      'A Starter organisation runs out of videos, buys an HD video pack, then moves up to Growth.',
    area: 'billing',
    scene: 'market',
    caption: '8 of 8 used',
    steps: [
      {
        text: 'On Starter all 8 videos this month are made: the usage banner says so.',
        href: withPlan('#/projects', 'allowance_used'),
        cta: 'Starter, all used',
      },
      {
        text: 'Press Generate on the draft: 403 quota_exceeded opens the dialog with “Upgrade your plan” or “Buy a video pack”.',
        href: draft,
        cta: 'Generate',
      },
      {
        text: `“Buy a video pack” opens Your plan at the video packs: press Buy on “5 HD videos” (${PRICE_TEXT.packHd5}; 15 are ${PRICE_TEXT.packHd15}), then “Complete demo payment” on the simulated checkout.`,
        href: '#/settings/billing#topups',
        cta: 'Buy a video pack',
      },
      {
        text: 'Your plan now shows 5 pack videos left: they work on any plan, are used after the plan’s videos and last 3 months. Generate again: it runs on a pack video (4 left).',
        href: draft,
        cta: 'Generate on a pack video',
      },
      {
        text: 'Change your plan: choose Growth. A higher plan applies now: the preview shows the new monthly price and the amount due today for the rest of the period. Confirm: 20 videos a month and 3 seats.',
        href: '#/settings/billing#change',
        cta: 'Move up to Growth',
      },
      {
        text: 'Business → Brand: voice profiles carry a “Not in your plan” badge (an Enterprise feature, arranged with sales). Adding a voice answers 403 plan_tier.',
        href: '#/business',
        cta: 'Not in your plan',
      },
    ],
  },
  {
    id: 'change-plan',
    title: 'Change the plan and how often you pay',
    outcome:
      'The owner moves up to Pro (applies now, pays the difference), down to Starter (applies at the end of the period), keeps the current plan, and moves to yearly.',
    area: 'billing',
    scene: 'kitchen',
    caption: 'Growth, monthly',
    steps: [
      {
        text: 'Your plan: Growth, monthly, 15.5 of 20 videos used this month (carousels, slideshows and text videos count ¼), renewal date. Under “Change your plan” choose Pro: the preview says it applies now and what is due today.',
        href: withPlan('#/settings/billing#change', 'active_monthly'),
        cta: 'Upgrade preview',
      },
      {
        text: '“Review change”, then “Pay … and change”: the plan is Pro at once, with 45 videos a month, 3 businesses and 10 seats.',
        href: '#/settings/billing#change',
        cta: 'Upgrade now',
      },
      {
        text: 'Now choose Starter: the preview says it applies at the end of the period, nothing to pay now. Confirm: Your plan shows “From <date>: Starter, monthly”.',
        href: '#/settings/billing#change',
        cta: 'Downgrade later',
      },
      {
        text: 'Changed your mind? Press “Keep my current plan”: the scheduled change is dropped.',
        href: '#/settings/billing',
        cta: 'Keep my plan',
      },
      {
        text: 'On a weekly plan (Starter, 2 videos a week, counted Monday to Sunday) switch to Yearly: a longer period applies now and the new yearly period starts today.',
        href: withPlan('#/settings/billing#change', 'active_weekly'),
        cta: 'Weekly to yearly',
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
        text: 'Your plan: status “Payment failed” with the days of grace left, and the latest invoice open. Plan changes wait until the payment is sorted.',
        href: '#/settings/billing',
        cta: 'Your plan',
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
      'The owner cancels at the end of the period (undoable until then); the organisation turns read-only, is kept 90 days, then deleted; the account can be deleted too.',
    area: 'billing',
    scene: 'kitchen',
    caption: 'Closing the shop',
    steps: [
      {
        text: 'Your plan → “Cancel plan” and confirm: “Your plan ends on …”, with full access until then. “Keep my plan” undoes it any time before. No refund for the part-used period.',
        href: withPlan('#/settings/billing', 'active_monthly'),
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
