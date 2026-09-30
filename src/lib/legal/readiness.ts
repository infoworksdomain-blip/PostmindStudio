import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_LOCALE } from '../i18n/locales';
import { legalContentDir, LEGAL_DOCS, type LegalDoc } from './documents';
import { legalTextState, unfilledMarkers } from './markers';

// Phase 18 §3 / §7 "Operator must provide" item 5 — the legal-readiness gate.
//   - Admin shows a warning while ANY en-GB legal document is missing, still the placeholder, or
//     (Phase 20.4) a draft whose [[…]] fill-in markers are not filled in yet.
//   - Production public sign-up (the launch flag STUDIO_SIGNUPS_ENABLED) stays closed while terms
//     or privacy is any of those: signupsOpen() answers closed with the reason, the sign-up
//     screen (Track A) shows "not open yet", and scripts/legal/check-ready.ts fails the VPS
//     preflight.

/** Documents that must be the operator's finished text before production sign-up opens. */
export const LAUNCH_REQUIRED_DOCS: readonly LegalDoc[] = ['terms', 'privacy'];

export type LegalDocState = 'missing' | 'placeholder' | 'fill_in' | 'ready';

export interface LegalDocStatus {
  doc: LegalDoc;
  present: boolean;
  /** Not finished: the placeholder, or a draft with fill-in markers left (see `state`). */
  placeholder: boolean;
  state: LegalDocState;
  /** The fill-in markers still in the text, e.g. ["[[COMPANY LEGAL NAME]]"]. */
  unfilled: string[];
}

export interface LegalReadiness {
  docs: LegalDocStatus[];
  /** Every document is present and finished. */
  ready: boolean;
  /** Launch-required documents not finished yet (empty = sign-up may open). */
  launchBlockers: LegalDoc[];
}

function statusOf(doc: LegalDoc, text: string | null): LegalDocStatus {
  if (text === null)
    return { doc, present: false, placeholder: false, state: 'missing', unfilled: [] };
  const state = legalTextState(text);
  return {
    doc,
    present: true,
    placeholder: state !== 'ready',
    state,
    unfilled: state === 'fill_in' ? unfilledMarkers(text) : [],
  };
}

export async function legalReadiness(dir: string = legalContentDir()): Promise<LegalReadiness> {
  const docs = await Promise.all(
    LEGAL_DOCS.map(async (doc): Promise<LegalDocStatus> => {
      try {
        return statusOf(doc, await readFile(join(dir, DEFAULT_LOCALE, `${doc}.md`), 'utf8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return statusOf(doc, null);
        throw err;
      }
    }),
  );
  const notReady = (s: LegalDocStatus) => s.state !== 'ready';
  return {
    docs,
    ready: docs.every((s) => !notReady(s)),
    launchBlockers: docs
      .filter((s) => LAUNCH_REQUIRED_DOCS.includes(s.doc) && notReady(s))
      .map((s) => s.doc),
  };
}

/** Every distinct fill-in marker left across the documents (for the operator's messages). */
export function unfilledAcross(readiness: Pick<LegalReadiness, 'docs'>): string[] {
  return [...new Set(readiness.docs.flatMap((d) => d.unfilled))];
}

export type SignupsClosedReason = 'disabled' | 'legal_placeholder';

export type SignupsState = { open: true } | { open: false; reason: SignupsClosedReason };

/**
 * Whether public sign-up is open. STUDIO_SIGNUPS_ENABLED=false closes it (invite-only). In
 * production it also stays closed until terms and privacy are the operator's finished text;
 * development and test are not blocked, so the drafts never get in the way locally.
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
