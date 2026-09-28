# Phase 16 — Multilingual Studio interface

**Operator decision, 2026-09-28:** Studio is multilingual. It supports English (en-GB default,
en-US), French, Spanish, Arabic, German, Italian, Portuguese, Hindi and Mandarin Chinese
(Simplified). Nigerian Pidgin is excluded.

Language support for video content is built in Phase 15 Track C. That covers per-project language,
native script writing, voices, captions, fonts and right-to-left Arabic in overlays. This phase
localises the Studio app itself. It runs after Phase 15 merges, because it touches every screen.

## 16.1 i18n foundation

- **Library.** `next-intl` (App Router support). Pin the version and confirm current docs.
- **Locale choice.** Signed-in users choose their locale in Settings; it falls back to
  `Accept-Language`, then en-GB.
- **Formatting.** Every date, number, currency and relative time goes through
  `Intl.*` with the active locale. `src/lib/client/format.ts` is already Intl-based and gains a
  locale parameter.
- **Message catalogues.** One catalogue per locale under `messages/<locale>.json`, with keys
  grouped by screen. English is the source of truth, and a CI check fails when a key is missing
  in any locale.
- **Translations.** They are produced by the pipeline's own LLM path in a one-off script
  (`scripts/i18n/translate.ts`). The script keeps placeholders and ICU plurals intact, never
  changes the English catalogue, and flags every machine-translated string for human review
  (`needs_review` list per locale).
- **Server-rendered text** (API error messages shown in the UI) maps to message keys: the error
  `code` becomes the key, with the server `message` as fallback.

## 16.2 Right-to-left (Arabic)

- **Page direction.** `dir="rtl"` and `lang` on `<html>` per locale.
- **Layout.** Tailwind logical properties (`ms-`/`me-`/`ps-`/`pe-`, `start`/`end`) replace
  `ml`/`mr`/`left`/`right` across `src/components/studio/**`. `src/components/ui/**` is shadcn;
  radix already handles `dir` through `DirectionProvider`.
- **Mirroring.** Direction-dependent icons are mirrored: chevrons, arrows, the timeline.
- **Charts and timelines.** The overlay timeline and charts keep time running left to right, as
  video tools conventionally do, but their labels are right-to-left.

## 16.3 Screens

Every screen in `src/app/(studio)/**` is localised, including /welcome, /analytics/publications,
the share page (public, locale from `Accept-Language`) and the Admin Centre. The demo gets a
language switcher and ships all 10 catalogues.

## 16.4 Tests

- Catalogue completeness, placeholder parity and ICU validity for every locale.
- Component tests render in en-GB, ar (RTL) and zh-Hans.
- A visual smoke in the demo per locale.
- Formatting tests for each locale: dates, currency and plural forms.

## 16.5 Notifications and email templates

Notification titles and bodies are stored as a message key plus parameters, and rendered in the
reader's locale. Email templates (Wave B) get the same keys.

## Out of scope

- Translating customer content that customers write themselves.
- Legal text, which needs human legal translation.
- Pidgin (excluded).

## Foundation (built 2026-09-28) — how the pieces fit

| Piece | Where |
| --- | --- |
| Locales, endonyms, `dir`, cookie, Accept-Language negotiation | `src/lib/i18n/locales.ts` |
| Per-request locale + catalogue (next-intl, no locale in URLs) | `src/i18n/request.ts`, `next.config.ts`, `src/app/layout.tsx` |
| Client provider (next-intl + radix `DirectionProvider` + switch) | `src/components/studio/i18n/intl-provider.tsx` |
| Language switcher (header) | `src/components/studio/i18n/language-switcher.tsx` |
| Catalogues | `messages/<locale>.json` (11), `messages/<locale>.review.json` (10) |
| Locale-bound formatting | `useFormat()` in `src/lib/client/format.ts` |
| API errors by code | `errors.codes.*`, `useErrorMessage()` in `src/lib/client/api.ts` |
| Notifications by key | `notifications.*`, `src/components/studio/notification-text.ts` |
| Checks | `npx tsx scripts/i18n/check-catalogues.ts`, `test/unit/i18n-catalogues.test.ts` (runs in `npm test`) |
| Review lists | `npx tsx scripts/i18n/review-list.ts` |
| Physical-CSS report | `npx tsx scripts/i18n/check-physical-css.ts` (informational now; `--fail` at the end of Phase 16) |

The locale comes from the `studio.locale` cookie (set by the switcher), then `Accept-Language`,
then en-GB. The share page (`/p/:token`) uses the same rule, so an anonymous viewer gets their
browser's language. The demo bundles every catalogue and switches in place.

## How to localise a screen (area agents: follow exactly)

**1. Your namespace.** Every catalogue already has an empty top-level object for each area:
`create`, `review`, `slideshow`, `overlays`, `projects`, `publications`, `calendar`, `business`,
`connections`, `library`, `analytics`, `admin`, `onboarding`, `share`, `templates`, `account`,
`approvals`. Edit **only your own** namespace in all 11 files. Do not touch other namespaces or
the foundation ones (`common`, `shell`, `errors`, `primitives`, `format`, `notifications`). If you
need a shared string that is missing, add it to your own namespace.

**2. Keys.** Nest by component, then element, in camelCase. Name the meaning, not the words.

```json
"projects": {
  "list": {
    "title": "Projects",
    "description": "Every video, from first brief to published post.",
    "newVideo": "New video",
    "filters": { "all": "All", "inProgress": "In progress" },
    "empty": { "title": "No projects yet", "body": "Create your first video." },
    "rowCount": "{count, plural, =0 {No projects} one {# project} other {# projects}}"
  }
}
```

**3. In the component.**

```tsx
'use client';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import { useErrorMessage } from '@/lib/client/api';

export function ProjectsList() {
  const t = useTranslations('projects.list');
  const tc = useTranslations('common.actions');   // shared buttons: cancel, save, retry…
  const f = useFormat();                          // locale-bound formatters
  const errorMessage = useErrorMessage();
  …
  <PageHeader title={t('title')} description={t('description')} />
  <Button aria-label={t('deleteAria', { name: p.name })}>{tc('delete')}</Button>
  <span>{f.pence(p.costPence)} · {f.relative(p.updatedAt)}</span>
  <StateBadge {...f.projectState(p.state)} />
  toast.error(errorMessage(err));
}
```

Keys are type-checked (`src/lib/i18n/messages.ts` augments next-intl with the en-GB shape): a
typo in a key or namespace fails `npm run typecheck`. For a key chosen at run time, map to a
literal key type (`` t(`filters.${f}` as const) ``, with `f` a union of known filters) or keep a
typed record of keys.

**4. Rules.**

- **No string concatenation or template literals** to build sentences. One key per sentence,
  with ICU arguments: `"{name} was published to {platform}"`. Word order differs per language.
- **Plurals** are ICU: `{count, plural, =0 {…} one {# …} other {# …}}`. The check fails when a
  locale lacks its categories — Arabic needs `zero one two few many other`; fr/es/it/pt need
  `one other` (`many` optional); de/en/hi need `one other`; zh-Hans only `other`.
- **Never put an ASCII apostrophe `'` in a message** (ICU escape character). Use `’`.
- **Formatting** always goes through `useFormat()`: `pence`, `count`, `number`, `percent`,
  `duration`, `relative`, `date(iso, options?)`, `list`, `projectState`, `publicationState`,
  `platform`. Never call `toLocaleString('en-GB')` or `Intl.*('en-GB')`. Money stays GBP.
- **Every visible string and every `aria-label`, `title`, `placeholder`, `alt`** comes from the
  catalogue. Product and platform names (PostMind Studio, TikTok, YouTube…) are not translated.
- **User content is never translated** (project names, captions, comments).
- **Logical CSS only**: `ms-/me-`, `ps-/pe-`, `start-/end-`, `text-start/end`, `border-s/e`,
  `rounded-s/e`. No `ml-/mr-/pl-/pr-/left-/right-/text-left/text-right`. Run
  `npx tsx scripts/i18n/check-physical-css.ts` and clear your files. A deliberate physical class
  (the overlay timeline and charts keep time running left to right) carries an
  `i18n-physical-ok` comment on the same line.
- **Directional icons** (chevrons, arrows, back/next) get `className="rtl:-scale-x-100"`.
  Icons that are not directional (play, check, plus) are not mirrored.
- **Server text shown in the UI**: API errors go through `errorMessage` / `useErrorMessage`
  (code → `errors.codes.*`, server message as fallback). Do not render `err.message` directly.

**5. Translations.** Write all 10 non-source catalogues yourself: natural UI copy for the
locale, not word-for-word, same keys and ICU arguments. Keep register consistent with the
foundation: fr/de/pt-PT formal (vous/Sie), es/it/pt-BR informal (tú/tu/você), ar Modern Standard
Arabic, hi polite आप, zh-Hans Mainland conventions with full-width punctuation. Then run
`npx tsx scripts/i18n/review-list.ts` so every new key is in `messages/<locale>.review.json`.

**6. Tests.** `render()` from `@testing-library/react` already wraps every tree in the en-GB
provider (test/setup-dom.ts), and a missing key throws, so existing en-GB assertions keep
working. To test another locale: `render(withLocale('ar', <Screen />))` from
`test/i18n-wrapper.ts` (sets `<html dir="rtl">`). Each area adds at least one ar and one zh-Hans
render of its main screen. Then run:

```
npx tsx scripts/i18n/check-catalogues.ts
npx vitest run test/unit/i18n-catalogues.test.ts <your tests>
npm run typecheck
```

**7. Demo.** Check your screens in the demo in en-GB, ar (mirrored, no horizontal overflow) and
zh-Hans with the header language switcher, and read the console: a missing key logs
`[i18n] MISSING_MESSAGE` and renders the key path.
