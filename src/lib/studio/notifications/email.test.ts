import type { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { ConfigurationError, NotImplementedError } from '../../errors';
import {
  CORE_EMAIL_PENDING_MESSAGE,
  CoreEmailSender,
  createEmailSender,
  emailProviderFromEnv,
  emailSenderFromEnv,
} from './email';
import { ResendEmailSender } from './resend-sender';

describe('email provider switch (STUDIO_EMAIL_PROVIDER via STUDIO_MODE)', () => {
  it('defaults to resend in standalone mode and none in core mode', () => {
    expect(emailProviderFromEnv({})).toBe('resend');
    expect(emailProviderFromEnv({ STUDIO_MODE: 'core' })).toBe('none');
    expect(emailProviderFromEnv({ STUDIO_MODE: 'core', STUDIO_EMAIL_PROVIDER: ' ' })).toBe('none');
    expect(emailProviderFromEnv({ STUDIO_EMAIL_PROVIDER: 'NONE' })).toBe('none');
    expect(emailSenderFromEnv({ STUDIO_MODE: 'core' })).toBeNull();
  });

  it('selects the Core sender for "core"', () => {
    expect(emailProviderFromEnv({ STUDIO_EMAIL_PROVIDER: 'core' })).toBe('core');
    expect(emailSenderFromEnv({ STUDIO_EMAIL_PROVIDER: 'Core' })).toBeInstanceOf(CoreEmailSender);
  });

  it('refuses unknown providers', () => {
    expect(() => emailProviderFromEnv({ STUDIO_EMAIL_PROVIDER: 'ses' })).toThrow(
      ConfigurationError,
    );
    expect(() => emailProviderFromEnv({ STUDIO_EMAIL_PROVIDER: 'smtp' })).toThrow(
      ConfigurationError,
    );
  });

  it('createEmailSender builds the Resend sender, the Core sender or none', () => {
    const deps = { db: {} as PrismaClient, logger: pino({ level: 'silent' }) };
    expect(createEmailSender({ ...deps, env: {} })).toBeInstanceOf(ResendEmailSender);
    expect(createEmailSender({ ...deps, env: {} })?.provider).toBe('resend');
    expect(createEmailSender({ ...deps, env: { STUDIO_EMAIL_PROVIDER: 'core' } })).toBeInstanceOf(
      CoreEmailSender,
    );
    expect(createEmailSender({ ...deps, env: { STUDIO_MODE: 'core' } })).toBeNull();
    // Resend needs the database: the database-free helper never builds it.
    expect(emailSenderFromEnv({})).toBeNull();
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
