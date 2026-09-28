// BACKLOG 17.9 — server-originated failure reasons in the reader's language.
//
// The server stores failure reasons as `<code>: <detail>` (e.g. `script_safety_block: <the
// checker's reason>`, `planning_failed: kill_switch_workspace: …`, `runway/rate_limited: <the
// provider's message>`). The UI parses the stable code and its parameters here and translates
// the sentence (messages/<locale>.json → failures.*). What follows the code is kept only when it
// is text the server did not write itself — a provider's message, a checker's reason, a
// reviewer's note — and is shown untranslated as a detail. A reason with no known code is shown
// exactly as stored (the English fallback). Pure: no React, no server imports.

export const FAILURE_CODES = [
  'cancelled_by_user',
  'brief_too_vague',
  'restricted_topics',
  'script_safety_block',
  'script_safety_review',
  'script_safety_blocked_by_review',
  'content_safety_blocked_by_review',
  'content_safety_block',
  'quality_failed',
  'quality_gate_error',
  'planning_failed',
  'slideshow_incomplete',
  'upload_missing',
  'script_regenerate_failed',
  'asset_generation_failed',
  'composition_failed',
  'cost_cap_paused',
  'kill_switch',
  'rejected',
  'business_deleted',
  'organisation_deleted',
  'scheduling_failed',
  'youtube_quota_deferred',
  'robots_blocked',
  'no_pages',
  'scan_cost_cap',
  'scan_images_capped',
  'ownership_disputed',
  'provider_failure',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export const KILL_SWITCH_LEVELS = [
  'global',
  'workspace',
  'project',
  'provider',
  'platform',
] as const;
export type KillSwitchLevelName = (typeof KILL_SWITCH_LEVELS)[number];

/** Provider and platform error classes with a catalogue label (failures.classes.<class>). */
export const ERROR_CLASSES = [
  'rate_limited',
  'timeout',
  'provider_unavailable',
  'unavailable',
  'auth',
  'insufficient_credits',
  'invalid_request',
  'content_policy',
  'output_truncated',
  'result_expired',
  'needs_reconnect',
  'quota_exceeded',
  'invalid_media',
  'outcome_unknown',
  'unknown',
] as const;
export type ErrorClassName = (typeof ERROR_CLASSES)[number];

/** One failed quality check named in a quality_failed / content_safety_block reason. */
export interface FailedCheck {
  platform: string;
  check: string;
}

export interface ParsedFailure {
  code: FailureCode;
  /** Kill-switch level, provider/platform + error class, shot numbers, amounts. */
  params: {
    level?: KillSwitchLevelName;
    source?: string;
    errorClass?: string;
    shots?: number[];
    checks?: FailedCheck[];
    pence?: number;
  };
  /** Text the server did not write (provider message, checker reason, reviewer note). */
  detail: string | null;
  /** The reason a wrapper code (planning_failed, scheduling_failed, …) carries. */
  cause: ParsedFailure | null;
  /** The cause when it has no known code: shown as stored. */
  rawCause: string | null;
}

const has = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

/** Rows written before 17.9 stored these sentences without a code. */
const LEGACY_SENTENCES: Record<string, FailureCode> = {
  'YouTube upload quota reached; retrying after the daily reset': 'youtube_quota_deferred',
  "The site's robots.txt does not allow PostMindStudio to fetch the homepage": 'robots_blocked',
  'No pages could be fetched': 'no_pages',
  'Stopped: website ownership was disputed': 'ownership_disputed',
};

/** Codes whose text after the colon is the server's own English: not shown. */
const SERVER_WORDED: ReadonlySet<FailureCode> = new Set<FailureCode>([
  'brief_too_vague',
  'restricted_topics',
  'slideshow_incomplete',
  'upload_missing',
  'script_regenerate_failed',
  'cost_cap_paused',
  'youtube_quota_deferred',
  'robots_blocked',
  'no_pages',
  'scan_cost_cap',
  'scan_images_capped',
  'ownership_disputed',
]);

/** Codes whose text after the colon is another reason (parsed as the cause). */
const WRAPPERS: ReadonlySet<FailureCode> = new Set<FailureCode>([
  'planning_failed',
  'composition_failed',
  'quality_gate_error',
  'scheduling_failed',
]);

const KILL = /^kill_switch_(global|workspace|project|provider|platform)\b(?::\s*[\s\S]*)?$/;
const KILL_STILL = /^kill_switch_still_engaged:\s*(global|workspace|project|provider|platform)\b/;
const SOURCE_CLASS = /^([a-z][a-z0-9_-]*)\/([a-z_]+):\s*([\s\S]*)$/;
const CODED = /^([a-z][a-z0-9_]*):\s*([\s\S]*)$/;
const SCAN_CAP = /^Stopped at the scan cost cap \((\d+)p\)(: some images were not indexed)?/;

function make(
  code: FailureCode,
  params: ParsedFailure['params'] = {},
  detail: string | null = null,
): ParsedFailure {
  return { code, params, detail: detail?.trim() || null, cause: null, rawCause: null };
}

function shotsOf(detail: string): number[] {
  return [...detail.matchAll(/(?:^|;\s*)shot (\d+):/g)].map((m) => Number(m[1]));
}

function checksOf(detail: string): FailedCheck[] {
  return [...detail.matchAll(/(?:^|;\s*)([a-z_]+)\/([a-z_]+)(?: \[BLOCK\])?:/g)].map((m) => ({
    platform: m[1] as string,
    check: m[2] as string,
  }));
}

function coded(code: FailureCode, rest: string): ParsedFailure {
  if (WRAPPERS.has(code)) {
    const cause = parseFailure(rest);
    return { ...make(code), cause, rawCause: cause ? null : rest.trim() || null };
  }
  if (code === 'asset_generation_failed') return make(code, { shots: shotsOf(rest) });
  if (code === 'quality_failed' || code === 'content_safety_block')
    return make(code, { checks: checksOf(rest) });
  if (code === 'scan_cost_cap' || code === 'scan_images_capped') {
    const pence = SCAN_CAP.exec(rest)?.[1];
    return make(code, pence ? { pence: Number(pence) } : {});
  }
  return make(code, {}, SERVER_WORDED.has(code) ? null : rest);
}

/**
 * The stable code, parameters and untranslated detail of one stored failure reason, or null
 * when the reason has no code this build knows (show it as stored).
 */
export function parseFailure(raw: string | null | undefined): ParsedFailure | null {
  const reason = raw?.trim();
  if (!reason) return null;
  const legacy = LEGACY_SENTENCES[reason];
  if (legacy) return make(legacy);
  const legacyCap = SCAN_CAP.exec(reason);
  if (legacyCap)
    return make(legacyCap[2] ? 'scan_images_capped' : 'scan_cost_cap', {
      pence: Number(legacyCap[1]),
    });
  if (has(FAILURE_CODES, reason)) return make(reason);
  const kill = KILL.exec(reason) ?? KILL_STILL.exec(reason);
  if (kill) return make('kill_switch', { level: kill[1] as KillSwitchLevelName });
  const scheduling = /^scheduling failed:\s*([\s\S]*)$/.exec(reason);
  if (scheduling) return coded('scheduling_failed', scheduling[1] ?? '');
  const reviewed = /^(script|content)_safety_blocked_by_review:\s*([\s\S]*)$/.exec(reason);
  if (reviewed)
    return make(`${reviewed[1] as 'script' | 'content'}_safety_blocked_by_review`, {}, reviewed[2]);
  const sourced = SOURCE_CLASS.exec(reason);
  if (sourced)
    return make(
      'provider_failure',
      { source: sourced[1] as string, errorClass: sourced[2] as string },
      sourced[3],
    );
  const match = CODED.exec(reason);
  if (match && has(FAILURE_CODES, match[1] as string))
    return coded(match[1] as FailureCode, match[2] ?? '');
  return null;
}
