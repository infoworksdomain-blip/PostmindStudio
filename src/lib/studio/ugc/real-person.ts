// BACKLOG 21.4 — UGC actors are generated people only. The acceptable use policy (content/legal,
// section 2) forbids depicting real, identifiable people without their consent, and Studio's
// actors must never imitate a celebrity, public figure or anyone the owner names. Two checks:
//   1. this one, deterministic, on the brief before anything is spent (create, regenerate with a
//      new brief): obvious requests to impersonate, look like or sound like someone;
//   2. ideation (pipeline/ideation.ts with the UGC schema) flags subtler ones (e.g. a named
//      influencer) and the run stops with UGC_REAL_PERSON_REASON before Layer 2.
// The provider's own filters (Veo blocks prominent people) are the last line.

/** The project's errorReason when a UGC brief asked for a real person (UI: create.ugc.refused). */
export const UGC_REAL_PERSON_REASON = 'ugc_real_person_refused';

/** Shown by the API (and translated by the UI from the reason above). */
export const UGC_REAL_PERSON_MESSAGE =
  'UGC actors are generated people. They cannot imitate, look like or sound like a real person, celebrity or public figure. Describe the kind of person you want instead (for example "a friendly woman in her thirties").';

const KEYWORDS =
  /\b(celebrit(?:y|ies)|famous (?:person|actor|actress|singer|footballer|athlete|influencer|youtuber|tiktoker)|public figure|impersonat\w*|deep ?fakes?|look-?alikes?|body double|doppelg[aä]nger|pretend(?:ing|s)? to be|dressed up as|clone (?:of|the voice))\b/i;

/** A capitalised name of at least two words ("Taylor Swift", "David Beckham"). */
const NAME = String.raw`[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)+`;

/** "sounds like / voice of / played by / starring / impersonating" + a name. */
const NAMED_VOICE = new RegExp(
  String.raw`\b(?:sounds?|sounding|voice of|voiced by|played by|starring|impersonating)\s+(?:like\s+)?(?:a\s+young\s+)?${NAME}`,
  'u',
);

/**
 * A person who "looks like" / "resembles" + a name. Places ("make it look like New York") are not
 * matched: the verb must follow a word for a person.
 */
const NAMED_LOOK = new RegExp(
  String.raw`\b(?:actor|actress|person|presenter|creator|influencer|guy|girl|woman|man|someone|somebody|he|she|they|who)\s+(?:\w+\s+)?(?:looks?|looking|resembles?|resembling)\s+(?:just\s+|exactly\s+)?(?:like\s+)?(?:a\s+young\s+)?${NAME}`,
  'u',
);

/** The owner (or someone they name) as the actor: a real person, refused here. */
const SELF =
  /\b(?:looks?|sounds?|looking|sounding)\s+(?:exactly\s+)?like\s+(?:me|myself|my (?:husband|wife|partner|son|daughter|mum|mom|dad|boss|friend|colleague))\b/i;

export interface RealPersonCheck {
  refused: boolean;
  /** The words that triggered the refusal (logged, never shown verbatim). */
  match?: string;
}

/** Deterministic check of a UGC brief (and product name) for a real-person request. */
export function checkRealPersonRequest(
  ...texts: Array<string | null | undefined>
): RealPersonCheck {
  for (const text of texts) {
    if (!text) continue;
    for (const pattern of [KEYWORDS, NAMED_VOICE, NAMED_LOOK, SELF]) {
      const found = pattern.exec(text);
      if (found) return { refused: true, match: found[0].slice(0, 80) };
    }
  }
  return { refused: false };
}
