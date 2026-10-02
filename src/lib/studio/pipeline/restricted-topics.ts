// Spec 13.3 / BACKLOG 20.18 — the brief touches a topic the brand kit (or business profile) marks
// as restricted. The project rests in DRAFT with RESTRICTED_TOPICS_REASON and
// metadata.pendingRestrictedTopics; the project page lists the topics and the owner either
// continues (generate with confirmRestrictedTopics) or edits the brief. Before 20.18 no UI showed
// the topics or sent the confirmation, so such a project could never go further.

/** The project's errorReason while it waits for the owner to confirm restricted topics. */
export const RESTRICTED_TOPICS_REASON = 'restricted_topics: user confirmation required (spec 13.3)';

/** At most this many topics are stored and shown. */
export const MAX_PENDING_TOPICS = 10;
/** A topic longer than this is cut. */
export const MAX_TOPIC_CHARS = 120;

/** True for a stored reason that means "confirm the restricted topics" (code, with or without text). */
export function isRestrictedTopicsReason(reason: string | null | undefined): boolean {
  return /^restricted_topics(?::|$)/.test(reason?.trim() ?? '');
}

/** The pending topics in stored metadata (or a model answer), cleaned: unique, trimmed, ≤ 10. */
export function pendingTopicsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const topics = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.replace(/\s+/g, ' ').trim().slice(0, MAX_TOPIC_CHARS))
    .filter(Boolean);
  return [...new Set(topics)].slice(0, MAX_PENDING_TOPICS);
}
