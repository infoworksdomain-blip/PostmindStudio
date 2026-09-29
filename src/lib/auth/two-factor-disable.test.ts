import { createOTP } from '@better-auth/utils/otp';
import { symmetricEncrypt } from 'better-auth/crypto';
import { describe, expect, it } from 'vitest';
import { normaliseSecondFactorCode, verifySecondFactor } from './two-factor-disable';

// Phase 18 §5.6: turning 2FA off needs a current TOTP or an unused backup code. The row is built
// exactly as Better Auth's twoFactor plugin stores it (both fields encrypted with the auth secret).

const KEY = 'test-auth-secret-at-least-32-characters-long';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

async function storedRow(backupCodes: string[]) {
  return {
    secret: await symmetricEncrypt({ key: KEY, data: TOTP_SECRET }),
    backupCodes: await symmetricEncrypt({ key: KEY, data: JSON.stringify(backupCodes) }),
  };
}

describe('verifySecondFactor', () => {
  it('accepts the current TOTP code', async () => {
    const row = await storedRow(['AbCdE-12345']);
    const code = await createOTP(TOTP_SECRET, { period: 30, digits: 6 }).totp();
    await expect(verifySecondFactor(row, code, KEY)).resolves.toBe(true);
  });

  it('accepts an unused backup code', async () => {
    const row = await storedRow(['AbCdE-12345', 'FgHiJ-67890']);
    await expect(verifySecondFactor(row, 'FgHiJ-67890', KEY)).resolves.toBe(true);
  });

  it('refuses a wrong, empty or foreign code', async () => {
    const row = await storedRow(['AbCdE-12345']);
    const current = await createOTP(TOTP_SECRET, { period: 30, digits: 6 }).totp();
    const wrong = current === '000000' ? '111111' : '000000';
    await expect(verifySecondFactor(row, wrong, KEY)).resolves.toBe(false);
    await expect(verifySecondFactor(row, '', KEY)).resolves.toBe(false);
    await expect(verifySecondFactor(row, 'ZZZZZ-00000', KEY)).resolves.toBe(false);
  });

  it('refuses when the row was encrypted with another secret', async () => {
    const row = await storedRow(['AbCdE-12345']);
    await expect(
      verifySecondFactor(row, 'AbCdE-12345', 'another-secret-that-is-also-32-chars-long'),
    ).resolves.toBe(false);
  });
});

describe('normaliseSecondFactorCode', () => {
  it('drops spaces and ignores non-strings', () => {
    expect(normaliseSecondFactorCode(' 123 456 ')).toBe('123456');
    expect(normaliseSecondFactorCode(123456)).toBe('');
  });
});
