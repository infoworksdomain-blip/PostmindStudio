import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_LOCALE } from '../i18n/locales';
import { isPlaceholder, legalContentDir, LEGAL_DOCS, type LegalDoc } from './documents';

// Phase 18 §3 / §7 "Operator must provide" item 5 — the legal-readiness gate.
//   - Admin shows a warning while ANY en-GB legal document is missing or still the placeholder.
//   - Production public sign-up (the launch flag STUDIO_SIGNUPS_ENABLED) stays closed while terms
//     or privacy is missing or the placeholder: signupsOpen() answers closed with the reason, the
//     sign-up screen (Track A) shows "not open yet", and scripts/legal/check-ready.ts fails the
//     VPS preflight.

/** Documents that must be the operator's real text before production sign-up opens. */
export const LAUNCH_REQUIRED_DOCS: readonly LegalDoc[] = ['terms', 'privacy'];

export interface LegalDocStatus {
  doc: LegalDoc;
  present: boolean;
  placeholder: boolean;
}

export interface LegalReadiness {
  docs: LegalDocStatus[];
  /** Every document is present and replaced. */
  ready: boolean;
  /** Launch-required documents still missing or placeholder (empty = sign-up may open). */
  launchBlockers: LegalDoc[];
}

export async function legalReadiness(dir: string = legalContentDir()): Promise<LegalReadiness> {
  const docs = await Promise.all(
    LEGAL_DOCS.map(async (doc): Promise<LegalDocStatus> => {
      try {
        const text = await readFile(join(dir, DEFAULT_LOCALE, `${doc}.md`), 'utf8');
        return { doc, present: true, placeholder: isPlaceholder(text) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
          return { doc, present: false, placeholder: false };
        throw err;
      }
    }),
  );
  const notReady = (s: LegalDocStatus) => !s.present || s.placeholder;
  return {
    docs,
    ready: docs.every((s) => !notReady(s)),
    launchBlockers: docs
      .filter((s) => LAUNCH_REQUIRED_DOCS.includes(s.doc) && notReady(s))
      .map((s) => s.doc),
  };
}

export type SignupsClosedReason = 'disabled' | 'legal_placeholder';

export type SignupsState = { open: true } | { open: false; reason: SignupsClosedReason };

/**
 * Whether public sign-up is open. STUDIO_SIGNUPS_ENABLED=false closes it (invite-only). In
 * production it also stays closed until terms and privacy are the operator's text; development
 * and test are not blocked, so the placeholders never get in the way locally.
 */
export function signupsState(
  readiness: Pick<LegalReadiness, 'launchBlockers'>,
  env: Record<string, string | undefined> = process.env,
): SignupsState {
  if (env.STUDIO_SIGNUPS_ENABLED?.trim().toLowerCase() === 'false')
    return { open: false, reason: 'disabled' };
  if (env.NODE_ENV === 'production' && readiness.launchBlockers.length > 0)
    return { open: false, reason: 'legal_placeholder' };
  return { open: true };
}

/** Convenience for the sign-up screen and its server action. */
export async function signupsOpen(
  env: Record<string, string | undefined> = process.env,
): Promise<SignupsState> {
  return signupsState(await legalReadiness(legalContentDir(env)), env);
}
