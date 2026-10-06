import { PROJECTS } from '../api/ids';
import { PRICE_TEXT } from './price-text';
import { projectHref as p, withPlan, type Workflow } from './workflow-types';

// Phase 18 / 21.5 workflows: sign-up to the first video, subscribing, using up the videos (video
// packs, adding a channel, the channel limit), changing the plan (upgrade now, downgrade at the end
// of the period), a failed payment, and cancelling. One plan, paid per channel: £29 per channel a
// month with 8 videos per channel. The payment steps use the demo's own "Demo checkout
// (simulated)" page (no card details, one "Complete demo payment" button); `withPlan` links set
// the billing state.

const draft = p(PROJECTS.meetTheBakers.id);

export const BILLING_WORKFLOWS: Workflow[] = [
  {
    id: 'signup-first-video',
    title: 'Sign up to the first video',
    outcome:
      'A visitor finds Studio, picks how many channels to pay for, signs up, sets up the bakery and starts the free trial to generate.',
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
        text: `One plan, paid per channel: choose 3 channels and Monthly (${PRICE_TEXT.channelMonthly} per channel, 24 videos a month included), then press “Start free trial”.`,
        href: '#/pricing',
        cta: 'Pricing',
      },
      {
        text: 'Sign up as Amara Okafor, amara@leedssourdough.example, with a long password: watch the strength meter, then “Create account”.',
        href: '#/sign-up?next=%2Fsettings%2Fbilling%3Fchannels%3D3%26interval%3Dmonth',
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
        text: 'On Your plan choose 3 channels, Monthly, and press “Start free trial” (14 days with 5 videos, £0 today), then “Complete demo payment” on the simulated checkout: the banner counts down 14 days and Generate works.',
        href: withPlan('#/settings/billing?channels=3&interval=month', 'no_plan'),
        cta: 'Start the trial',
      },
    ],
  },
  {
    id: 'start-subscription',
    title: 'Start a subscription',
    outcome:
      'A returning organisation (its trial already used) picks 6 channels, billed yearly, and pays once upfront.',
    area: 'billing',
    scene: 'coffee',
    caption: '6 channels, yearly',
    steps: [
      {
        text: `Pricing: switch to Yearly (${PRICE_TEXT.channelYearly} per channel, paid upfront: 2 months free) and Weekly (${PRICE_TEXT.channelWeekly} per channel a week, dearer over a month). The video packs and the questions are below.`,
        href: '#/pricing',
        cta: 'Pricing',
      },
      {
        text: 'Your plan after an earlier plan ended shows the plan picker. Choose 6 channels and Yearly, then “Continue to payment”.',
        href: withPlan('#/settings/billing', 'cancelled'),
        cta: 'Plan picker',
      },
      {
        text: 'The clearly labelled “Demo checkout (simulated)” page: 6 channels, the yearly price, 576 videos a year included, no card fields. Press “Complete demo payment”.',
        href: '#/demo-checkout?kind=channels&channels=6&interval=year',
        cta: 'Demo checkout',
      },
      {
        text: 'Back on Your plan: 6 channels, yearly, the renewal date, and 48 videos this month (8 per channel, released each month).',
        href: '#/settings/billing',
        cta: 'Active plan',
      },
      {
        text: 'Your channels: all six connected platforms publish, so nothing shows “add a channel”.',
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
    title: 'Use up the videos, buy a pack, add a channel',
    outcome:
      'A 1-channel organisation runs out of videos, buys an HD video pack, then adds a channel; with 3 channels the fourth platform asks for another.',
    area: 'billing',
    scene: 'market',
    caption: '8 of 8 used',
    steps: [
      {
        text: 'On 1 channel all 8 videos this month are made: the usage banner says so.',
        href: withPlan('#/projects', 'allowance_used'),
        cta: '1 channel, all used',
      },
      {
        text: 'Press Generate on the draft: 403 quota_exceeded opens the dialog with “Add a channel” or “Buy a video pack”.',
        href: draft,
        cta: 'Generate',
      },
      {
        text: `“Buy a video pack” opens Your plan at the video packs: press Buy on “5 HD videos” (${PRICE_TEXT.packHd5}; 15 are ${PRICE_TEXT.packHd15}), then “Complete demo payment” on the simulated checkout.`,
        href: '#/settings/billing#topups',
        cta: 'Buy a video pack',
      },
      {
        text: 'Your plan now shows 5 pack videos left: they work on any channel, are used after the plan’s videos and last 3 months. Generate again: it runs on a pack video (4 left).',
        href: draft,
        cta: 'Generate on a pack video',
      },
      {
        text: 'Change your plan: add a channel (2 channels). More channels apply now: the preview shows the new monthly price and the amount due today for the rest of the period. Confirm.',
        href: '#/settings/billing#change',
        cta: 'Add a channel',
      },
      {
        text: 'On 3 channels, six platforms are connected but only the first three (TikTok, Instagram, YouTube) publish. Connections and Your plan say Facebook, X and LinkedIn need another channel.',
        href: withPlan('#/connections', 'active_monthly'),
        cta: 'Channel limit',
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
    title: 'Change channels and how often you pay',
    outcome:
      'The owner adds channels (applies now, pays the difference), removes some (applies at the end of the period), keeps the current plan, and moves to yearly.',
    area: 'billing',
    scene: 'kitchen',
    caption: '3 channels, monthly',
    steps: [
      {
        text: 'Your plan: 3 channels, monthly, 19.5 of 24 videos used this month (carousels, slideshows and text videos count ¼), renewal date. Under “Change your plan” add two channels (5): the preview says it applies now and what is due today.',
        href: withPlan('#/settings/billing#change', 'active_monthly'),
        cta: 'Upgrade preview',
      },
      {
        text: '“Review change”, then “Pay … and change”: the plan is 5 channels at once and 40 videos a month are included.',
        href: '#/settings/billing#change',
        cta: 'Upgrade now',
      },
      {
        text: 'Now remove channels down to 2: the preview says it applies at the end of the period, nothing to pay now. Confirm: Your plan shows “From <date>: 2 channels, monthly”.',
        href: '#/settings/billing#change',
        cta: 'Downgrade later',
      },
      {
        text: 'Changed your mind? Press “Keep my current plan”: the scheduled change is dropped.',
        href: '#/settings/billing',
        cta: 'Keep my plan',
      },
      {
        text: 'On a weekly plan (2 channels, 4 videos a week, counted Monday to Sunday) switch to Yearly: a longer period applies now and the new yearly period starts today.',
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
