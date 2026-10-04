# Legal texts: all details filled in

**Status (4 October 2026): every detail is filled in and the legal scope is closed** (operator decision 2026-10-04, BACKLOG 21.2). The six texts in `content/legal/en-GB/` (terms, privacy, cookies, acceptable-use, dpa, subprocessors) are the operator's finished text: they contain no fill-in markers and no review notes, and `npx tsx scripts/legal/check-ready.ts` (or `npm run setup:check -- .secrets/production.env`) reports every document as `ok`, so production sign-up is not held back by the legal gate.

The gate still works: if a fill-in marker (two square brackets around a name) is ever added back to the Terms of Service or the Privacy Policy, public sign-up closes in production until it is filled in; the other four documents show a "draft" banner and an Admin Centre warning.

## Details used

| Detail | Value | Appears in |
| --- | --- | --- |
| Company legal name | Postmind AI Ltd (same value as `STUDIO_LEGAL_ENTITY_NAME`, shown in the footer) | All six |
| Company number | 17332378 (checked against Companies House on 30 September 2026) | terms, privacy |
| Registered address | 61 Bridge Street, Kington, Herefordshire, HR5 3DJ, United Kingdom | terms, privacy |
| Contact and privacy email | support@postmindai.pro | All six |
| Privacy lead | A director of Postmind AI Ltd (no DPO appointed) | privacy |
| ICO registration number | Not stated (removed on 30 September 2026 at the operator's request; the privacy policy states the company registration instead). Add a sentence with the number if the company registers for the data protection fee. | — |

## Decisions recorded when the scope was closed (2026-10-04)

- **Hosting:** Hetzner Online GmbH, Helsinki, Finland (EU), data centre `hel1` (privacy 7.1, dpa 10.1 and Annex 2, subprocessors).
- **International transfers:** for every provider that processes personal data in the United States, Singapore, Malaysia or Australia, the texts state the European Commission's Standard Contractual Clauses with the UK International Data Transfer Addendum, as incorporated in that provider's data processing terms, together with a transfer risk assessment kept on file (privacy 7.2, dpa 10.2, subprocessors). No Data Privacy Framework certification is claimed. Keep the transfer risk assessments on file and refresh them when a provider or its terms change.
- **AI presenters:** HeyGen shots use one licensed stock presenter chosen by us (`HEYGEN_AVATAR_ID`); there is no customer photo upload (acceptable-use 2.4, subprocessors). Reword 2.4 if customer-photo presenters are ever added.

## Facts in the texts that come from settings

The texts state the default values of these settings. If you change a setting in `production.env`, change the text too.

| Setting                                     | Default in the texts                                                                                                 | Where the text mentions it                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `STUDIO_TRIAL_DAYS`                         | 14-day trial                                                                                                         | terms 6.2                                        |
| Trial limits (`TRIAL` in `src/lib/studio/billing/catalogue.ts`) | 5 short videos, no long video. The trial's AI usage limits (£10 a day, £15 in total) are internal and not stated (21.5: no costs shown to customers) | terms 6.2 |
| Channel plan (`src/lib/studio/billing/channel-plan.ts`) | 1 to 6 Channels; weekly, monthly or yearly (yearly paid upfront); 8 videos per Channel a month, 2 a week on weekly, 96 a year released 8 a month on yearly; upgrades now (prorated), downgrades at period end; no long videos. Prices are on the pricing page only | terms 3, 6.1, 6.3, 6.6, 7.2, 7.4 |
| Video packs (`TOP_UP_PACKS` in `src/lib/studio/billing/catalogue.ts`) | 5 or 15 HD videos, any Channel, used after the plan's videos, valid 3 months | terms 6.5 |
| Cost caps, per-video budget (`src/lib/studio/cost/project-budget.ts`), AI clip budget (`pipeline/clip-budget.ts`) | Described as internal usage limits, without figures | terms 6.3, acceptable-use 7.4, dpa Annex 2 |
| `STUDIO_BILLING_GRACE_DAYS`                 | 7 days of full access after a failed payment                                                                         | terms 7.5                                        |
| `STUDIO_CANCELLED_RETENTION_DAYS`           | 90 days read-only after a paid subscription ends                                                                     | terms 15.2, privacy 8                            |
| `STUDIO_PURGE_GRACE_DAYS`                   | 30 days between scheduling deletion and deleting                                                                     | terms 15.2, privacy 8, dpa 8.2                   |
| `STUDIO_AUDIT_RETENTION_DAYS`               | Audit log kept 2 years                                                                                               | privacy 8                                        |
| `PG_BACKUP_RETENTION_DAYS`, storage backups | Backups gone within 30 days                                                                                          | terms 15.3, privacy 8, dpa 8.2 and Annex 2       |
| `R2_JURISDICTION` (production R2 buckets)   | Default (global) jurisdiction: files and backups may be stored outside the UK and EEA (operator decision 2026-09-30) | privacy 7, dpa 10.1 and Annex 2, subprocessors   |
| Hetzner location                            | Helsinki, Finland (EU), `hel1`                                                                                       | privacy 7.1, dpa 10.1 and Annex 2, subprocessors |
| `AWS_REGION` (KMS)                          | London (eu-west-2)                                                                                                   | privacy 7.1, subprocessors                       |
| `ASSEMBLYAI_REGION`                         | `eu`                                                                                                                 | subprocessors                                    |
| `SENTRY_DSN`, `BROWSERLESS_API_KEY`         | Listed as "only if enabled"                                                                                          | subprocessors                                    |

Keep each provider's contracting entity, processing region and transfer terms on the Sub-processors page in step with its own data processing terms, and remove any provider whose key you do not set.

The HTML comment at the top of each text is not shown on the website. Translations (`content/legal/<locale>/`) are optional; a locale without its own file shows the English text with a note.
