import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createConsoleAuthMailer, createMemoryAuthMailer } from './auth-mailer';

describe('auth mailer contract', () => {
  it('the memory transport records what was sent', async () => {
    const mailer = createMemoryAuthMailer();
    await expect(
      mailer.sendAuthEmail('verifyEmail', 'a@example.com', { url: 'https://x/v?t=1' }, 'fr', {
        idempotencyKey: 'auth:v1',
      }),
    ).resolves.toEqual({ queued: true, suppressed: false });
    expect(mailer.sent).toEqual([
      {
        template: 'verifyEmail',
        to: 'a@example.com',
        params: { url: 'https://x/v?t=1' },
        locale: 'fr',
        options: { idempotencyKey: 'auth:v1' },
      },
    ]);
  });

  it('the console transport logs the link and only the recipient’s domain', async () => {
    const log = pino({ level: 'silent' });
    const info = vi.spyOn(log, 'info');
    await createConsoleAuthMailer(log).sendAuthEmail(
      'resetPassword',
      'someone@example.com',
      { url: 'https://studio/reset?token=t' },
      'en-GB',
    );
    const [fields] = info.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({ toDomain: 'example.com', url: 'https://studio/reset?token=t' });
    expect(JSON.stringify(fields)).not.toContain('someone@');
  });
});
