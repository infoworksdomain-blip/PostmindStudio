import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';

// BACKLOG 16.4 — catalogue checks (scripts/i18n/check-catalogues.ts, test/unit/i18n-catalogues
// .test.ts). en-GB is the source of truth; every other catalogue must have exactly its keys, every
// value must be valid ICU MessageFormat (parsed with @formatjs/icu-messageformat-parser, the
// parser behind intl-messageformat that next-intl formats with), use the same arguments, and
// give each plural the categories its locale needs. The review lists (messages/<locale>.review
// .json) must account for every key of a machine-written catalogue.

export type Catalogue = { [key: string]: string | Catalogue };

export interface CatalogueProblem {
  locale: string;
  key: string;
  kind:
    | 'missing'
    | 'extra'
    | 'type'
    | 'invalid_icu'
    | 'placeholders'
    | 'plural_categories'
    | 'ascii_apostrophe'
    | 'review_list';
  detail: string;
}

/** Leaf key paths → values ("shell.nav.items.create" → "Create"). Empty objects contribute none. */
export function flatten(catalogue: Catalogue, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(catalogue)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

/** Every key path (objects included), with its kind, for structural comparison. */
function shape(catalogue: Catalogue, prefix = ''): Map<string, 'string' | 'object'> {
  const out = new Map<string, 'string' | 'object'>();
  for (const [key, value] of Object.entries(catalogue)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, 'string');
    else {
      out.set(path, 'object');
      for (const [k, v] of shape(value, path)) out.set(k, v);
    }
  }
  return out;
}

interface PluralUse {
  argument: string;
  categories: string[];
}

interface Analysis {
  args: Set<string>;
  plurals: PluralUse[];
}

function walk(elements: MessageFormatElement[], acc: Analysis): Analysis {
  for (const el of elements) {
    switch (el.type) {
      case TYPE.argument:
      case TYPE.number:
      case TYPE.date:
      case TYPE.time:
        acc.args.add(el.value);
        break;
      case TYPE.select:
        acc.args.add(el.value);
        for (const option of Object.values(el.options)) walk(option.value, acc);
        break;
      case TYPE.plural:
        acc.args.add(el.value);
        acc.plurals.push({
          argument: el.value,
          categories: Object.keys(el.options).filter((k) => !k.startsWith('=')),
        });
        for (const option of Object.values(el.options)) walk(option.value, acc);
        break;
      case TYPE.tag:
        acc.args.add(el.value);
        walk(el.children, acc);
        break;
      default:
        break;
    }
  }
  return acc;
}

/** Parse one message; throws the parser's SyntaxError for invalid ICU. */
export function analyseMessage(message: string): Analysis {
  return walk(parse(message, { ignoreTag: false }), { args: new Set(), plurals: [] });
}

/**
 * Categories a plural must provide in this locale: CLDR's cardinal categories, except `many` in
 * languages where it only covers compact large numbers (fr/es/it/pt: "1 million de…") — optional
 * there. A category the locale never selects is reported as dead.
 */
const PLURAL_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'];

export function pluralCategoriesFor(locale: string): { required: string[]; allowed: string[] } {
  // Node versions differ in the order they report categories (Node 20: alphabetical; Node 24: CLDR),
  // so sort into CLDR order for stable messages.
  const allowed = [
    ...(new Intl.PluralRules(locale).resolvedOptions().pluralCategories as string[]),
  ].sort((a, b) => PLURAL_ORDER.indexOf(a) - PLURAL_ORDER.indexOf(b));
  const base = locale.split('-')[0] ?? locale;
  const manyOptional = ['fr', 'es', 'it', 'pt'].includes(base);
  return {
    allowed,
    required: allowed.filter((c) => !(manyOptional && c === 'many')),
  };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

export function checkCatalogue(
  locale: string,
  catalogue: Catalogue,
  source: Catalogue,
): CatalogueProblem[] {
  const problems: CatalogueProblem[] = [];
  const add = (key: string, kind: CatalogueProblem['kind'], detail: string) =>
    problems.push({ locale, key, kind, detail });

  const expected = shape(source);
  const actual = shape(catalogue);
  for (const [key, kind] of expected) {
    const got = actual.get(key);
    if (!got) add(key, 'missing', `missing (en-GB has a ${kind})`);
    else if (got !== kind) add(key, 'type', `is a ${got}, en-GB has a ${kind}`);
  }
  for (const key of actual.keys()) {
    if (!expected.has(key)) add(key, 'extra', 'not in en-GB');
  }

  const sourceValues = flatten(source);
  const { required, allowed } = pluralCategoriesFor(locale);
  for (const [key, value] of flatten(catalogue)) {
    if (value.includes("'")) {
      add(key, 'ascii_apostrophe', "contains ' (the ICU escape character) — use ’");
    }
    let analysis: Analysis;
    try {
      analysis = analyseMessage(value);
    } catch (err) {
      add(key, 'invalid_icu', err instanceof Error ? err.message : String(err));
      continue;
    }
    const sourceValue = sourceValues.get(key);
    if (sourceValue !== undefined) {
      try {
        const sourceArgs = analyseMessage(sourceValue).args;
        if (!sameSet(analysis.args, sourceArgs)) {
          add(
            key,
            'placeholders',
            `arguments {${[...analysis.args].sort().join(', ')}} ≠ en-GB {${[...sourceArgs].sort().join(', ')}}`,
          );
        }
      } catch {
        // The source's own ICU error is reported when en-GB itself is checked.
      }
    }
    for (const plural of analysis.plurals) {
      const missing = required.filter((c) => !plural.categories.includes(c));
      const dead = plural.categories.filter((c) => !allowed.includes(c));
      if (missing.length || dead.length) {
        add(
          key,
          'plural_categories',
          [
            missing.length && `{${plural.argument}} lacks ${missing.join(', ')}`,
            dead.length && `{${plural.argument}} has ${dead.join(', ')} (unused in ${locale})`,
          ]
            .filter(Boolean)
            .join('; '),
        );
      }
    }
  }
  return problems;
}

export interface ReviewList {
  locale: string;
  needs_review: string[];
  reviewed: string[];
}

/** Every key of a machine-written catalogue is either awaiting review or reviewed. */
export function checkReviewList(
  locale: string,
  catalogue: Catalogue,
  review: ReviewList | undefined,
): CatalogueProblem[] {
  if (!review) {
    return [
      {
        locale,
        key: '*',
        kind: 'review_list',
        detail: `messages/${locale}.review.json is missing`,
      },
    ];
  }
  const listed = new Set([...review.needs_review, ...review.reviewed]);
  const problems: CatalogueProblem[] = [];
  for (const key of flatten(catalogue).keys()) {
    if (!listed.has(key)) {
      problems.push({
        locale,
        key,
        kind: 'review_list',
        detail: 'not in the review list — run npx tsx scripts/i18n/review-list.ts',
      });
    }
  }
  return problems;
}

/** Keep reviewed keys, add every other key to needs_review; drop keys that no longer exist. */
export function buildReviewList(
  locale: string,
  catalogue: Catalogue,
  previous?: ReviewList,
): ReviewList {
  const keys = [...flatten(catalogue).keys()];
  const present = new Set(keys);
  const reviewed = (previous?.reviewed ?? []).filter((k) => present.has(k));
  const reviewedSet = new Set(reviewed);
  return {
    locale,
    needs_review: keys.filter((k) => !reviewedSet.has(k)),
    reviewed,
  };
}
