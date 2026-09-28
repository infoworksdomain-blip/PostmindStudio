import { CostCapPausedError, KillSwitchTriggeredError } from '../../errors';
import { runProvider, type ProviderRunDeps } from '../pipeline/provider-run';
import type { PlanTier } from '../providers/router';

// 15.C7 — automatic consent-phrase check on voice clones (spec 10.2: "the speaker must record a
// specific consent phrase before the voice is usable"). The consent recording is transcribed
// through the provider router (AssemblyAI, then OpenAI whisper-1 — 15.C1) and fuzzy-matched
// against the statement the speaker said they read:
//   passed      → the profile is usable (READY, or REQUIRES_VERIFICATION if ElevenLabs asked)
//   mismatch    → PENDING_REVIEW: the recording does not say the statement
//   unavailable → PENDING_REVIEW: no transcription (no provider, provider down, timeout);
//                 POST /voice-profiles/:id/consent-check runs the check again.
// Fail closed: a clone is never usable on an unverified recording.
//
// Matching: word-level longest common subsequence between the normalised statement and the
// transcript, as a share of the statement's words. Speech-to-text drops or mishears the odd
// word and adds fillers ("um"), so 80% of the statement's words in order is the pass mark; the
// speaker's name must also be heard (it is what makes the consent theirs).

export type ConsentCheck = 'passed' | 'mismatch' | 'unavailable';

export const CONSENT_MATCH_THRESHOLD = 0.8;
/** A consent recording is short; the API request waits at most this long for a transcript. */
export const CONSENT_TRANSCRIBE_TIMEOUT_MS = 90_000;
const CONSENT_POLL_MS = 2_000;
const TRANSCRIPT_MAX_CHARS = 4_000;

/** Lower-case words without punctuation or diacritics ("Café," → "cafe"). */
export function consentWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function lcsLength(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (const wordA of a) {
    const next = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      next[j] =
        wordA === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, next[j - 1] ?? 0);
    }
    prev = next;
  }
  return prev[b.length] ?? 0;
}

/** Share of the statement's words heard in order (0–1). */
export function consentSimilarity(statement: string, transcript: string): number {
  const expected = consentWords(statement);
  if (expected.length === 0) return 0;
  return lcsLength(expected, consentWords(transcript)) / expected.length;
}

export function matchConsent(input: {
  statement: string;
  speakerName: string;
  transcript: string;
}): { check: Exclude<ConsentCheck, 'unavailable'>; similarity: number } {
  const similarity = consentSimilarity(input.statement, input.transcript);
  const heard = new Set(consentWords(input.transcript));
  const nameHeard = consentWords(input.speakerName).every((w) => heard.has(w));
  return {
    check: similarity >= CONSENT_MATCH_THRESHOLD && nameHeard ? 'passed' : 'mismatch',
    similarity: Math.round(similarity * 1000) / 1000,
  };
}

export interface ConsentCheckResult {
  check: ConsentCheck;
  transcript: string | null;
  similarity: number | null;
  reason?: string;
}

/** Transcribe the recording and match it; any transcription failure is "unavailable". */
export async function checkConsentRecording(
  deps: ProviderRunDeps,
  input: {
    organisationId: string;
    planTier: PlanTier;
    mediaUrl: string;
    statement: string;
    speakerName: string;
  },
): Promise<ConsentCheckResult> {
  let transcript: string;
  try {
    const run = await runProvider(
      {
        need: { kind: 'capability', capability: 'transcription' },
        planTier: input.planTier,
        request: {
          capability: 'transcription',
          organisationId: input.organisationId,
          mediaUrl: input.mediaUrl,
          durationSec: 30,
        },
      },
      {
        ...deps,
        config: {
          ...deps.config,
          providerTimeoutMs: CONSENT_TRANSCRIBE_TIMEOUT_MS,
          providerPollIntervalMs: CONSENT_POLL_MS,
        },
      },
    );
    const text = (run.output.metadata as { text?: unknown } | undefined)?.text;
    transcript = typeof text === 'string' ? text.slice(0, TRANSCRIPT_MAX_CHARS) : '';
  } catch (err) {
    // A paused budget or kill switch is not a consent problem: surface it to the caller.
    if (err instanceof CostCapPausedError || err instanceof KillSwitchTriggeredError) throw err;
    return {
      check: 'unavailable',
      transcript: null,
      similarity: null,
      reason: err instanceof Error ? err.message.slice(0, 300) : 'transcription failed',
    };
  }
  const match = matchConsent({
    statement: input.statement,
    speakerName: input.speakerName,
    transcript,
  });
  return { check: match.check, transcript, similarity: match.similarity };
}

/** The profile state a consent check leads to. */
export function stateAfterConsent(check: ConsentCheck, providerVerificationRequired: boolean) {
  if (check !== 'passed') return 'PENDING_REVIEW';
  return providerVerificationRequired ? 'REQUIRES_VERIFICATION' : 'READY';
}
