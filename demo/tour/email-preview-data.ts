import type { EmailTemplate } from '@/emails/catalogue';
import type { EmailParams } from '@/emails/params';

// The transactional emails the tour previews (#/tour/email/<template>) and their sample
// parameters (Leeds Sourdough, fictional). Dates are relative to today.

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();
export const EMAIL_APP_URL = 'https://studio.example';

export const EMAIL_PREVIEWS: Partial<
  Record<EmailTemplate, { title: string; params: EmailParams }>
> = {
  orgDeletionScheduled: {
    title: 'Retention: the organisation will be deleted (after 90 days read-only)',
    params: { name: 'Amara', organisationName: 'Leeds Sourdough Ltd', deleteAt: at(30) },
  },
  subscriptionCanceled: {
    title: 'Subscription cancelled',
    params: { name: 'Amara', endsAt: at(18) },
  },
  paymentFailed: {
    title: 'Payment failed (grace period)',
    params: { name: 'Amara', graceEndsAt: at(4) },
  },
  trialEnding: {
    title: 'Trial ends in 3 days',
    // 21.5: the per-channel plan is named by the product (email-params.ts planDisplayName).
    params: { name: 'Amara', planName: 'PostMind Studio', trialEndsAt: at(3) },
  },
  monthPlanned: {
    title: 'Plan my month: every post is scheduled (the one summary email)',
    params: {
      name: 'Amara',
      url: `${EMAIL_APP_URL}/plans/plan-october`,
      postCount: 29,
      needsAttention: 1,
      startDate: at(1),
      endDate: at(30),
    },
  },
  topupReceipt: {
    title: 'Video pack receipt',
    params: { name: 'Amara', packName: '5 HD videos' },
  },
  invite: {
    title: 'Invitation to join an organisation',
    params: {
      url: `${EMAIL_APP_URL}/invite/inv-demo`,
      organisationName: 'Leeds Sourdough Ltd',
      inviterName: 'Amara Okafor',
      role: 'Publisher',
    },
  },
  verifyEmail: {
    title: 'Verify your email address',
    params: { url: `${EMAIL_APP_URL}/api/auth/verify-email?token=demo` },
  },
  accountDeletionScheduled: {
    title: 'Account deletion scheduled',
    params: { name: 'Amara', deleteAt: at(30) },
  },
};

export function isPreviewTemplate(value: string): value is EmailTemplate {
  return Object.prototype.hasOwnProperty.call(EMAIL_PREVIEWS, value);
}
