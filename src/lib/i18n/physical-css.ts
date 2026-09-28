// BACKLOG 16.2 — Tailwind classes tied to a physical side (left/right) that do not mirror in RTL.
// Studio components use the logical equivalents instead (plans/phase-16.md, "Logical CSS"):
//   ml-/mr- → ms-/me-   pl-/pr- → ps-/pe-   left-/right- → start-/end-
//   text-left/right → text-start/end   border-l/r → border-s/e   rounded-l/r → rounded-s/e
// scripts/i18n/check-physical-css.ts reports them per file.

export interface PhysicalClassHit {
  line: number;
  column: number;
  token: string;
  suggestion: string;
}

const LOGICAL: Record<string, string> = {
  ml: 'ms',
  mr: 'me',
  pl: 'ps',
  pr: 'pe',
  left: 'start',
  right: 'end',
  'border-l': 'border-s',
  'border-r': 'border-e',
  'rounded-l': 'rounded-s',
  'rounded-r': 'rounded-e',
  'rounded-tl': 'rounded-ss',
  'rounded-tr': 'rounded-se',
  'rounded-bl': 'rounded-es',
  'rounded-br': 'rounded-ee',
  'scroll-ml': 'scroll-ms',
  'scroll-mr': 'scroll-me',
  'scroll-pl': 'scroll-ps',
  'scroll-pr': 'scroll-pe',
};

// A class token (optionally variant-prefixed, optionally negative) whose utility starts with a
// physical prefix, e.g. "ml-2", "-right-0.5", "md:pl-4", "border-l", "text-right".
const PATTERN =
  /(?<=^|[\s"'`{(:!])(-?)(ml|mr|pl|pr|left|right|border-l|border-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|rounded-l|rounded-r|scroll-ml|scroll-mr|scroll-pl|scroll-pr)(-[\w./[\]%-]+|(?=[\s"'`}):]|$))|(?<=^|[\s"'`{(:!])text-(left|right)(?=[\s"'`}):]|$)/g;

const SPACING = new Set([
  'ml',
  'mr',
  'pl',
  'pr',
  'left',
  'right',
  'scroll-ml',
  'scroll-mr',
  'scroll-pl',
  'scroll-pr',
]);
const VALUE = /^-(\d|\[|\(|px\b|full\b|auto\b)/;

export function findPhysicalClasses(source: string): PhysicalClassHit[] {
  const hits: PhysicalClassHit[] = [];
  source.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(PATTERN)) {
      const [token] = match;
      const textSide = match[4];
      let suggestion: string;
      if (textSide) {
        suggestion = textSide === 'left' ? 'text-start' : 'text-end';
      } else {
        const negative = match[1] ?? '';
        const prefix = match[2] ?? '';
        const rest = match[3] ?? '';
        // Spacing and position utilities need a Tailwind value (ml-2, right-1/2, pl-[3px],
        // left-full, mr-auto); "left-to-right" in prose is not a class.
        if (SPACING.has(prefix) && !VALUE.test(rest)) continue;
        suggestion = `${negative}${LOGICAL[prefix] ?? prefix}${rest}`;
      }
      hits.push({ line: index + 1, column: (match.index ?? 0) + 1, token, suggestion });
    }
  });
  return hits;
}
