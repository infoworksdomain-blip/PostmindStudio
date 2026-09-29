import type { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authMailerFromEnv, createMemoryAuthMailer } from './auth-mailer';
import { mailerFromEnv } from './mailer';

// Phase 18 integration: which AuthMailer each process gets (web: ApiDeps.mailer and
// authMailerFromEnv; worker: PipelineDeps.mailer).

const enqueue = vi.fn(async () => ({ queued: true, suppressed: false }));
vi.mock('./outbox', () => ({ createEmailOutbox: () => ({ enqueue }) }));

const apiMailer = createMemoryAuthMailer();
vi.mock('../studio/api/context', () => ({ getApiDeps: async () => ({ mailer: apiMailer }) }));

const db = {} as PrismaClient;

function silentLogger() {
  const log = pino({ level: 'silent' });
  return { log, info: vi.spyOn(log, 'info'), error: vi.spyOn(log, 'error') };
}

async function send(mailer: ReturnType<typeof mailerFromEnv>) {
  return mailer.sendAuthEmail('verifyEmail', 'a@example.com', { url: 'https://x/v' }, 'en-GB');
}

describe('mailerFromEnv', () => {
  beforeEach(() => enqueue.mockClear());

  it('sends through the Resend outbox in production resend mode', async () => {
    const { log } = silentLogger();
    const mailer = mailerFromEnv({
      db,
      logger: log,
      env: { NODE_ENV: 'production', STUDIO_EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x' },
    });
    await expect(send(mailer)).resolves.toEqual({ queued: true, suppressed: false });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('uses the outbox in development when RESEND_API_KEY is set', async () => {
    const { log } = silentLogger();
    await send(mailerFromEnv({ db, logger: log, env: { RESEND_API_KEY: 're_x' } }));
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('only logs in tests and in development without a Resend key', async () => {
    for (const env of [{ NODE_ENV: 'test', RESEND_API_KEY: 're_x' }, { NODE_ENV: 'development' }]) {
      const { log, info } = silentLogger();
      await send(mailerFromEnv({ db, logger: log, env }));
      expect(info).toHaveBeenCalledOnce();
    }
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('is loud in production when the email provider is none', async () => {
    const { log, error } = silentLogger();
    const mailer = mailerFromEnv({
      db,
      logger: log,
      env: { NODE_ENV: 'production', STUDIO_EMAIL_PROVIDER: 'none' },
    });
    await expect(send(mailer)).resolves.toEqual({ queued: false, suppressed: false });
    expect(error).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('authMailerFromEnv', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns the console transport under tests', async () => {
    const { log, info } = silentLogger();
    await send(await authMailerFromEnv(log));
    expect(info).toHaveBeenCalledOnce();
    expect(apiMailer.sent).toEqual([]);
  });

  it("returns the process's ApiDeps mailer (Resend outbox) outside tests", async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { log } = silentLogger();
    expect(await authMailerFromEnv(log)).toBe(apiMailer);
  });
});
