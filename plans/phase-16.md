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
