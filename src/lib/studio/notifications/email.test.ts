import { describe, expect, it } from 'vitest';
import { ConfigurationError, NotImplementedError } from '../../errors';
import {
  CORE_EMAIL_PENDING_MESSAGE,
  CoreEmailSender,
  emailProviderFromEnv,
  emailSenderFromEnv,
} from './email';

describe('email provider switch (STUDIO_EMAIL_PROVIDER)', () => {
  it('is none when unset, empty or "none"', () => {
    expect(emailProviderFromEnv({})).toBe('none');
    expect(emailProviderFromEnv({ STUDIO_EMAIL_PROVIDER: ' ' })).toBe('none');
    expect(emailProviderFromEnv({ STUDIO_EMAIL_PROVIDER: 'NONE' })).toBe('none');
    expect(emailSenderFromEnv({})).toBeNull();
  });

  it('selects the Core sender for "core"', () => {
    expect(emailProviderFromEnv({ STUDIO_EMAIL_PROVIDER: 'core' })).toBe('core');
    expect(emailSenderFromEnv({ STUDIO_EMAIL_PROVIDER: 'Core' })).toBeInstanceOf(CoreEmailSender);
  });

  it('refuses Studio-sent providers until the operator decides and they are built', () => {
    expect(() => emailProviderFromEnv({ STUDIO_EMAIL_PROVIDER: 'resend' })).toThrow(
      ConfigurationError,
    );
    expect(() => emailProviderFromEnv({ STUDIO_EMAIL_PROVIDER: 'ses' })).toThrow(/not built/);
    expect(() => emailProviderFromEnv({ STUDIO_EMAIL_PROVIDER: 'smtp' })).toThrow(
      ConfigurationError,
    );
  });
});

describe('CoreEmailSender', () => {
  it('throws NotImplementedError until Core publishes an email API', async () => {
    const send = new CoreEmailSender().send({
      notificationId: 'n1',
      organisationId: 'org',
      recipientUserIds: ['u1'],
      kind: 'publication_failed',
      subject: 's',
      text: 't',
      link: null,
    });
    await expect(send).rejects.toBeInstanceOf(NotImplementedError);
    await expect(send).rejects.toThrow(CORE_EMAIL_PENDING_MESSAGE);
  });
});
