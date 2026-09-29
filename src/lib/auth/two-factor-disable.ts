import { createOTP } from '@better-auth/utils/otp';
import { symmetricDecrypt, type SecretConfig } from 'better-auth/crypto';

// Phase 18 §5.6 — disabling 2FA needs a current TOTP code or one of the backup codes, on top of
// the password Better Auth's /two-factor/disable already checks (its own body has no code field,
// so auth/config.ts runs this in a before-hook). The stored row is the twoFactor plugin's:
// `secret` encrypted with the auth secret, `backupCodes` a JSON list encrypted the same way
// (storeBackupCodes: 'encrypted'). Same decryption and TOTP settings (30 s, 6 digits) as the
// plugin: better-auth 1.7.6 dist/plugins/two-factor/{totp,backup-codes}/index.mjs (read
// 2026-09-29).

export interface StoredTwoFactor {
  secret: string;
  backupCodes: string;
}

export const TOTP_PERIOD_S = 30;
export const TOTP_DIGITS = 6;

/** Codes are typed with spaces or dashes sometimes; backup codes keep their dash. */
export function normaliseSecondFactorCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, '') : '';
}

async function backupCodesOf(row: StoredTwoFactor, key: string | SecretConfig): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await symmetricDecrypt({ key, data: row.backupCodes }));
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

/** True when `code` is the current TOTP (±1 step, the library default) or an unused backup code. */
export async function verifySecondFactor(
  row: StoredTwoFactor,
  code: string,
  key: string | SecretConfig,
): Promise<boolean> {
  if (!code) return false;
  if (/^\d{6}$/.test(code)) {
    const secret = await symmetricDecrypt({ key, data: row.secret });
    if (await createOTP(secret, { period: TOTP_PERIOD_S, digits: TOTP_DIGITS }).verify(code))
      return true;
  }
  return (await backupCodesOf(row, key)).includes(code);
}
