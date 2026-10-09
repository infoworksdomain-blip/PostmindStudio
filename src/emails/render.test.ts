import { describe, expect, it } from 'vitest';
import { ValidationError } from '../lib/errors';
import { ALL_MESSAGES } from '../lib/i18n/all-messages';
import { LOCALES, type Locale } from '../lib/i18n/locales';
import { EMAIL_TEMPLATES, TEMPLATES, isUnsubscribable, type EmailTemplate } from './catalogue';
import type { EmailParams } from './params';
import { renderEmail } from './render';
import { renderUnsubscribePage } from './unsubscribe-page';

// Phase 18 §2.8 (Track B tests): every template renders in all 11 locales with no ICU
// placeholder left over, ar is RTL, values are escaped, links are http(s) only, and only
// notification mail carries an unsubscribe link.

const APP_URL = 'https://studio.example.com';
const messages = async (locale: Locale) => ALL_MESSAGES[locale];

const SAMPLE_PARAMS: Record<EmailTemplate, EmailParams> = {
  verifyEmail: { url: 'https://studio.example.com/verify-email?token=t1', name: 'Amara' },
  resetPassword: { url: 'https://studio.example.com/reset-password?token=t2' },
  passwordChanged: { name: 'Amara' },
  emailChangeConfirm: { url: 'https://studio.example.com/verify?t=3', newEmail: 'new@example.com' },
  emailChanged: { newEmail: 'new@example.com' },
  accountExists: {},
  twoFactorChanged: { enabled: true },
  newSignIn: { device: 'Firefox on Windows' },
  invite: {
    url: 'https://studio.example.com/invite/abc',
    organisationName: 'Acme Bakery',
    inviterName: 'Ben',
    role: 'publisher',
  },
  ownershipTransferred: { organisationName: 'Acme Bakery', newOwnerName: 'Ben' },
  trialEnding: { planName: 'Standard', trialEndsAt: '2026-10-13T00:00:00.000Z' },
  paymentFailed: { graceEndsAt: '2026-10-06T00:00:00.000Z' },
  paymentActionRequired: { url: 'https://invoice.stripe.com/i/acct_1/test' },
  subscriptionChanged: { planName: 'Plus' },
  subscriptionCanceled: { endsAt: '2026-11-01T00:00:00.000Z' },
  topupReceipt: { packName: '10 short videos' },
  accountDeletionScheduled: { deleteAt: '2026-10-29T00:00:00.000Z' },
  orgDeletionScheduled: { organisationName: 'Acme Bakery', deleteAt: '2026-10-29T00:00:00.000Z' },
  dataExportReady: {
    url: 'https://files.example.com/export.zip',
    expiresAt: '2026-10-06T00:00:00.000Z',
  },
  monthPlanned: {
    url: 'https://studio.example.com/plans/plan-1',
    postCount: 58,
    needsAttention: 2,
    startDate: '2026-10-01T12:00:00.000Z',
    endDate: '2026-10-30T12:00:00.000Z',
  },
  notification: {
    kind: 'publication_failed',
    subject: 'Publishing “Launch” to TikTok failed',
    text: 'Token expired — open the project to retry.',
    link: 'https://studio.example.com/projects/p1',
    messageKey: 'publicationFailed',
    messageParams: JSON.stringify({ name: 'Launch', platform: 'tiktok', reason: 'Token expired' }),
  },
};

describe('email templates in every locale', () => {
  it('has a sample for every template', () => {
    expect(Object.keys(SAMPLE_PARAMS).sort()).toEqual([...EMAIL_TEMPLATES].sort());
  });

  for (const locale of LOCALES) {
    it(`renders every template in ${locale}`, async () => {
      for (const template of EMAIL_TEMPLATES) {
        const email = await renderEmail({
          template,
          params: SAMPLE_PARAMS[template],
          locale,
          appUrl: APP_URL,
          supportEmail: 'help@example.com',
          unsubscribeUrl: `${APP_URL}/api/email/unsubscribe?token=v1.x.y`,
          messages,
        });
        const where = `${locale} ${template}`;
        expect(email.locale, where).toBe(locale);
        expect(email.subject.length, where).toBeGreaterThan(3);
        for (const part of [email.subject, email.text]) {
          expect(part, where).not.toMatch(/[{}]/);
          expect(part, where).not.toContain('email.templates');
        }
        expect(email.html, where).toContain(`lang="${locale}"`);
        expect(email.html, where).toContain(locale === 'ar' ? 'dir="rtl"' : 'dir="ltr"');
        expect(email.text, where).toContain('help@example.com');
        const hasUnsubscribe = email.text.includes('/api/email/unsubscribe');
        expect(hasUnsubscribe, where).toBe(isUnsubscribable(template));
        const spec = TEMPLATES[template];
        if (spec.cta !== false && (SAMPLE_PARAMS[template].url || spec.defaultPath)) {
          const target = String(SAMPLE_PARAMS[template].url ?? `${APP_URL}${spec.defaultPath}`);
          expect(email.html, where).toContain(`href="${target}"`);
        }
      }
    });
  }

  it('matches the en-GB text snapshots', async () => {
    const texts: Record<string, string> = {};
    for (const template of EMAIL_TEMPLATES) {
      const email = await renderEmail({
        template,
        params: SAMPLE_PARAMS[template],
        locale: 'en-GB',
        appUrl: APP_URL,
        unsubscribeUrl: `${APP_URL}/api/email/unsubscribe?token=v1.x.y`,
        messages,
      });
      texts[template] = `Subject: ${email.subject}\n\n${email.text}`;
    }
    expect(texts).toMatchSnapshot();
  });
});

describe('renderEmail', () => {
  it('formats dates in the reader’s locale and selects on booleans', async () => {
    const fr = await renderEmail({
      template: 'trialEnding',
      params: SAMPLE_PARAMS.trialEnding,
      locale: 'fr',
      appUrl: APP_URL,
      messages,
    });
    expect(fr.subject).toBe('Votre essai Standard se termine le 13 octobre 2026');
    const off = await renderEmail({
      template: 'twoFactorChanged',
      params: { enabled: false },
      locale: 'en-GB',
      appUrl: APP_URL,
      messages,
    });
    expect(off.subject).toBe('Two-factor authentication turned off');
  });

  it('shows the hosted logo by absolute URL with the brand name as alt text (26.2)', async () => {
    const email = await renderEmail({
      template: 'invite',
      params: SAMPLE_PARAMS.invite,
      locale: 'en-GB',
      appUrl: `${APP_URL}/`,
      messages,
    });
    expect(email.html).toContain(
      `<img src="${APP_URL}/brand/logo-light.png" alt="PostMind Studio" width="120" height="40"`,
    );
  });

  it('puts the same logo on the unsubscribe page', async () => {
    const html = renderUnsubscribePage({
      state: 'invalid',
      locale: 'en-GB',
      messages: await messages('en-GB'),
      appUrl: APP_URL,
    });
    expect(html).toContain(`src="${APP_URL}/brand/logo-light.png" alt="PostMind Studio"`);
  });

  it('escapes every value in the HTML part', async () => {
    const email = await renderEmail({
      template: 'invite',
      params: { ...SAMPLE_PARAMS.invite, organisationName: '<script>alert(1)</script>' },
      locale: 'en-GB',
      appUrl: APP_URL,
      messages,
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('refuses a non-http link and a missing required param', async () => {
    await expect(
      renderEmail({
        template: 'verifyEmail',
        params: { url: 'javascript:alert(1)' },
        locale: 'en-GB',
        appUrl: APP_URL,
        messages,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      renderEmail({ template: 'invite', params: {}, locale: 'en-GB', appUrl: APP_URL, messages }),
    ).rejects.toThrow(/Invalid params/);
  });

  it('falls back to en-GB for an unknown locale', async () => {
    const email = await renderEmail({
      template: 'resetPassword',
      params: SAMPLE_PARAMS.resetPassword,
      locale: 'xx',
      appUrl: APP_URL,
      messages,
    });
    expect(email.locale).toBe('en-GB');
    expect(email.subject).toBe('Reset your password');
  });

  it('falls back to en-GB when a catalogue cannot format a message', async () => {
    const broken = async (locale: Locale) =>
      locale === 'de'
        ? {
            ...ALL_MESSAGES.de,
            email: {
              ...ALL_MESSAGES.de.email,
              templates: { ...ALL_MESSAGES.de.email.templates, resetPassword: undefined },
            },
          }
        : ALL_MESSAGES[locale];
    const email = await renderEmail({
      template: 'resetPassword',
      params: SAMPLE_PARAMS.resetPassword,
      locale: 'de',
      appUrl: APP_URL,
      messages: broken as never,
    });
    expect(email.locale).toBe('en-GB');
  });

  it('renders a keyed notification in the reader’s language with platform labels', async () => {
    const email = await renderEmail({
      template: 'notification',
      params: SAMPLE_PARAMS.notification,
      locale: 'en-GB',
      appUrl: APP_URL,
      messages,
    });
    expect(email.subject).toBe('Publishing “Launch” to TikTok failed');
    expect(email.text).toContain('Token expired — open the project to retry.');
    expect(email.html).toContain('href="https://studio.example.com/projects/p1"');
  });

  it('uses the stored English text for unkeyed or unformattable notifications', async () => {
    const unkeyed = await renderEmail({
      template: 'notification',
      params: { kind: 'cost_alert', subject: 'Budget 80% used', text: 'Heads up.', link: null },
      locale: 'fr',
      appUrl: APP_URL,
      messages,
    });
    expect(unkeyed.subject).toBe('Budget 80% used');
    expect(unkeyed.html).not.toContain('Ouvrir dans PostMind Studio');
    const missingParam = await renderEmail({
      template: 'notification',
      params: {
        ...SAMPLE_PARAMS.notification,
        messageParams: JSON.stringify({ name: 'Launch' }),
      },
      locale: 'fr',
      appUrl: APP_URL,
      messages,
    });
    expect(missingParam.subject).toBe(SAMPLE_PARAMS.notification.subject);
  });

  it('shows "Untitled video" for an unnamed project', async () => {
    const email = await renderEmail({
      template: 'notification',
      params: {
        ...SAMPLE_PARAMS.notification,
        messageParams: JSON.stringify({ name: '', platform: 'x', reason: 'r' }),
      },
      locale: 'en-GB',
      appUrl: APP_URL,
      messages,
    });
    expect(email.subject).toBe('Publishing “Untitled video” to X failed');
  });
});
