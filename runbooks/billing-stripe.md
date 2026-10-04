# Billing with Stripe (Phase 18 Track C)

Studio sells three self-serve plans (BASIC, STANDARD, PLUS) and ENTERPRISE by quote, plus one-time top-up packs, through Stripe Checkout, the Stripe Customer Portal and Stripe Tax. This runbook covers set-up, day-to-day operations, the test-mode E2E, and the unit economics behind the prices.

Code map: `src/lib/studio/billing/*` (catalogue, gateway, entitlements, webhook, service, access gate, credits, reconcile), routes `src/app/api/studio/billing/*`, `src/app/api/billing/stripe/webhook/route.ts`, admin routes `src/app/api/studio/admin/organisations/[id]/entitlements` and `src/app/api/studio/admin/billing/subscriptions`, scripts `scripts/billing/*`.

Stripe API version: **2026-08-26.dahlia**, pinned in `stripe-client.ts` (stripe-node 22.6.2). Docs were read on 2026-09-29; links are in the source comments.

## 1. What the operator sets up in Stripe

Do it in **test mode first**, then repeat in live mode.

1. **API keys.** Put the secret key in `STRIPE_SECRET_KEY` (a restricted key also works if it can write Customers, Checkout Sessions, Billing Portal Sessions, Subscriptions and read Prices, Products, Invoices, Charges, Payment Methods and Events).
2. **Products and prices.**
   - Test mode: `STRIPE_SECRET_KEY=sk_test_… npx tsx scripts/billing/seed-stripe-test.ts` (use `--dry-run` first). It refuses live keys.
   - Live mode: create the same objects in the dashboard (table below). Each price must be GBP, tax behaviour **exclusive**, with the exact **lookup key**. Products need metadata `studio_tier` (BASIC / STANDARD / PLUS / ENTERPRISE). Tax code: *Software as a service (SaaS) – business use* (`txcd_10103001`).

   | Product (id in test) | Price lookup key | Amount | Type |
   |---|---|---|---|
   Price list **2026-09-30** ("lower prices, fewer videos", operator decision 2026-09-30). The lookup keys did not change; only the amounts did.

   | Product (id in test) | Price lookup key | Amount | Type |
   |---|---|---|---|
   | studio_basic | studio_basic_monthly | £29.00 | monthly |
   | studio_basic | studio_basic_yearly | £290.00 | yearly |
   | studio_standard | studio_standard_monthly | £99.00 | monthly |
   | studio_standard | studio_standard_yearly | £990.00 | yearly |
   | studio_plus | studio_plus_monthly | £349.00 | monthly |
   | studio_plus | studio_plus_yearly | £3,490.00 | yearly |
   | studio_enterprise | none (quoted per customer) | from £1,500/month | staff create it |
   | studio_topup_short10_basic | studio_topup_short10_basic | £15.00 | one-time |
   | studio_topup_short10_standard | studio_topup_short10_standard | £25.00 | one-time |
   | studio_topup_short10_plus | studio_topup_short10_plus | £35.00 | one-time |
   | studio_topup_long2_standard | studio_topup_long2_standard | £29.00 | one-time |
   | studio_topup_long2_plus | studio_topup_long2_plus | £55.00 | one-time |

   Annual is 10 × monthly on every tier (2 months free). The seed script creates these amounts from `REFERENCE_PRICES_PENCE` in `catalogue.ts`; re-running it on a test account that already has the old prices creates new prices with the same lookup keys and moves the keys to them (`transfer_lookup_key`), and archives nothing.

   **Moving from the 2026-09-29 price list (£59 / £209 / £749).** In test mode, re-run the seed script. In live mode, for each row above: open the product, *Add another price* at the new amount (GBP, tax exclusive, same interval), set the same lookup key and tick *Transfer lookup key from an existing price*, then archive the old price. Studio's pricing page shows the new amounts within 10 minutes. Existing subscribers stay on their old price until you migrate them in Stripe (their plan limits and cost caps change at once, because those come from the catalogue). Re-run `portal-config.ts --update bpc_…` afterwards.

3. **Customer Portal.** `STRIPE_SECRET_KEY=… APP_URL=https://<host> npx tsx scripts/billing/portal-config.ts` creates the configuration (payment methods, invoices, tax ids, plan switching among the three products with upgrades invoiced at once and downgrades / shorter intervals at period end, cancel at period end with a reason survey). Put the printed id in `STRIPE_PORTAL_CONFIGURATION_ID`. Re-run with `--update bpc_…` after changing prices.
4. **Webhook endpoint.** `https://<host>/api/billing/stripe/webhook`, API version 2026-08-26.dahlia, with these events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `customer.subscription.trial_will_end`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `customer.updated`, `charge.refunded`, `charge.dispute.created`.
   Put its signing secret in `STRIPE_WEBHOOK_SECRET`. The path is not behind Cloudflare challenge rules and needs no Caddy route.
5. **Stripe Tax.** Turn on Stripe Tax; add the UK VAT registration (and EU OSS if selling to EU consumers). Prices are tax-exclusive; the pricing page says "excl. VAT". Checkout collects the billing address and tax ids.
6. **Dunning.** Billing → *Manage failed payments*: Smart Retries on; after the last retry **mark the subscription unpaid** (recommended) or cancel it — both make the organisation read-only. Turn on Stripe's failed-payment and card-expiry emails. Studio adds its own in-app banner and owner emails (Track B templates).
7. **Trials.** Studio sets `trial_period_days` itself (STANDARD only, once per organisation). Stripe's "trial ending" reminder emails are optional; Studio sends `trialEnding` on `customer.subscription.trial_will_end`.
8. **Branding** for Checkout and the portal (logo, colours, support email and URL).

## 2. How it works

- **Catalogue** (`catalogue.ts`) holds every plan limit; amounts live in Stripe and are read with `prices.list(lookup_keys, expand data.product)`, cached 10 minutes. Env overrides (`STUDIO_QUOTA_*`, `STUDIO_ORG_*_CAP_PENCE_*`, `STUDIO_IMAGE_GEN_MONTHLY_CAP_*`, `STUDIO_MUSIC_MIN_TIER`, `STUDIO_VOICE_CLONE_MIN_TIER`) still win.
- **Entitlements.** Every webhook re-fetches the subscription from the API and stores it (`studio.subscriptions`); `entitlementsFromSubscription()` turns it into `org_entitlements` (tier, access, source). The reader caches for 30 s and applies the grace clock and admin overrides at read time.
- **Access gate.** `none` (never paid): set-up only; generate, publish and scan answer 402 `plan_required`. `read_only`: every mutation outside billing / account / org / members / notifications / export / downloads / deletes answers 402 `billing_required`. Workers check at job start: spend jobs stop, publish jobs are **held** (`metadata.billingHold`) and the 17.2 re-drive sweep publishes them once access is full again.
- **Quotas.** Standalone enforces quotas by default. The check runs under a Postgres advisory lock per (organisation, month) and reserves the slot, so concurrent generates cannot both take the last one.
- **Top-ups.** Paid `mode=payment` Checkout sessions create `usage_credits` (12 months, FIFO, once per session). A credit is spent only when the plan allowance is used up (one per project and month) and raises that month's cost cap by its worst-case cost. A refund removes the refunded share of unused credits.
- **Trial abuse.** One trial per organisation; the card fingerprint is stored in `trial_fingerprints`; a card that already trialled for another organisation ends the new trial at once (`trial_end=now`). The trial's provider spend is capped at £10 a day and £15 in total.
- **Safety nets.** `sweep-stripe-events` (every 10 min) re-processes events whose processing failed (they stay `processedAt NULL`, `lastError` says why; after 8 attempts a person looks). `reconcile-subscriptions` (03:15 UTC) stores every Stripe subscription again and recomputes every organisation.

## 3. Operations

- **Change a price with no deploy:** create a new Price on the same product with the same lookup key and "transfer lookup key" ticked (or re-run the seed script in test mode). The pricing page picks it up within 10 minutes. Existing subscribers keep their old price until migrated in Stripe. Re-run `portal-config.ts --update` so the portal offers the new price. **Re-check the margin maths in §5 first.**
- **ENTERPRISE:** create the subscription in Stripe on the `studio_enterprise` product (metadata `studio_tier=ENTERPRISE`) for the organisation's customer (it exists once the org opened Checkout once; otherwise create one with metadata `organisationId` and add the row via support). Then Admin → Billing → Entitlements: tier ENTERPRISE, custom limits, the agreed monthly price (the form refuses a price below the minimum for the organisation's monthly cost cap), and a reason. Set the custom cost cap in the existing Cost caps panel **before** the price, because the minimum is computed from it.
- **Staff override** (goodwill, incident): Admin → Organisations → search → Open → **Plan, access and trial** (or Admin → Billing → Entitlements by organisation id) with a reason and an expiry. Every change is audited (`entitlement.override_set`). Clearing it restores the Stripe-derived value.
- **Change an organisation's plan, access or caps (20.27).** Admin Centre (platform staff or superadmin, 2FA on) → **Organisations** tab → search by name, slug or id (the list shows plan, access, trial, subscription status and AI cost this month, 50 a page) → **Open**.
  - *Plan, access and trial* shows the effective tier, access and source, the trial (state, start and end, AI cost since it started against its £15 total and £10 a day), the stored row, the current override and the subscriptions.
  - *Set an override*: tier (Basic / Standard / Plus / Enterprise; Enterprise needs the agreed monthly price, at least the minimum shown), access (Full / Read-only / None), optional expiry, required reason. Access None or Read-only asks for confirmation. *Remove the override* (reason required) goes back to the Stripe-derived plan.
  - *Cost caps* (same page): daily and monthly £ override with a reason; **Clear back to plan default** removes both. Workers pick changes up within 30 s.
- **End a trial (20.27).** A trial's caps (£10 a day, £15 in total) apply instead of the plan's caps *and instead of any cost-cap override* while the trial runs, so raising cost caps alone does not help a trialing organisation. Any active staff override pauses the trial (source becomes `admin`, no trial caps), but the caps come back if the override expires or is removed while Stripe still says `trialing`. To end it for good: in *Set an override* tick **End the trial now** (shown only while a trial is running or paused), add the tier (e.g. Plus) and a reason, Save, and confirm. This stores `overrides.trial.endedAt` / `endedByUserId`; from then on the organisation never gets trial caps or the trial allowance again, even without an override, and the plan tier's caps (plus any cost-cap override) apply. Audited in `entitlement.override_set` with `trialEnded`. Stripe is **not** changed: the Stripe trial still ends, and the first invoice is charged, on its own date (cancel or change the subscription in Stripe if that should not happen).
- **Refunds:** refund in Stripe. A top-up refund removes the unused credits automatically; a subscription refund does not change access (cancel the subscription if access should end).
- **Disputes:** audited as `billing.dispute_created` and logged at warn level ("stripe dispute opened"); alert on that log line. Respond in the Stripe dashboard.
- **Webhook failures:** `SELECT id, type, attempts, "lastError" FROM studio.stripe_events WHERE "processedAt" IS NULL ORDER BY "receivedAt";`. Fix the cause; the sweeper retries. To force one: set `attempts = 0`.
- **Stuck entitlement:** run the reconcile job by hand (BullMQ `reconcile-subscriptions`) or `npx tsx -e` a call to `reconcileSubscriptions`.
- **Deletion (GDPR, §5.11):** `BillingService.cancelForDeletion` cancels live subscriptions immediately (no refund), marks the Stripe customer `studio_deleted=true` and keeps invoices (UK retention).

## 4. Test-clock E2E (operator-run, real Stripe test mode)

CI runs the scripted equivalent (`test/integration/billing-lifecycle.test.ts`, a fake Stripe with real webhook signatures). The real run:

1. Seed test mode (`seed-stripe-test.ts`), configure dunning as in §1.6 (after all retries: mark unpaid).
2. Start Studio locally with `STUDIO_BILLING=stripe`, test keys, and a database.
3. `stripe listen --forward-to http://localhost:3000/api/billing/stripe/webhook`; put the printed `whsec_…` in `STRIPE_WEBHOOK_SECRET` and restart.
4. `STRIPE_SECRET_KEY=sk_test_… DATABASE_URL=… npx tsx scripts/billing/e2e-test-clock.ts`.
   It creates a test clock and a customer, subscribes to STANDARD with a 14-day trial, and advances the clock: **trial → active → failed payment (pm_card_chargeCustomerFail) → grace (past_due, full) → read-only → recovered (pm_card_visa, invoices paid)**, checking Studio's stored entitlements after each step, then deletes the clock and its rows.
5. Record the result and date in PROGRESS.md.

## 5. Unit economics (price list 2026-09-30)

Assumptions (§P.2): worst-case Stripe fees 4.45 % (3.25 % international card + 0.7 % Billing + 0.5 % Tax) + 20p per invoice; infrastructure and email per org a month BASIC £2, STANDARD £4, PLUS £8, ENTERPRISE £40. Typical provider cost per video: BASIC short £0.90; STANDARD short £1.60, long (3 min) £9; PLUS short £2.40, long (6 min) £18. Typical use is 50 % of the allowance. Provider spend can never exceed the monthly cost cap (generation pauses at 100 %).

Margin = (price × 0.9555 − fixed fee − infra − provider cost) / price, per month (annual: price ÷ 12, fee ÷ 12). The same formula is in `catalogue.ts` (`grossMarginAtCap`, `grossMarginTypical`) and pinned by `catalogue.test.ts`.

| Tier | Short / long a month | Monthly cap | Daily cap | Full allowance at typical cost |
|---|---|---|---|---|
| BASIC | 20 / 0 | £20 | £5 | 20 × £0.90 = £18 |
| STANDARD | 40 / 1 (≤ 3 min) | £73 | £20 (21.3; was £15) | 40 × £1.60 + 1 × £9 = £73 |
| PLUS | 80 / 4 (≤ 6 min) | £264 | £90 (21.3; was £45) | 80 × £2.40 + 4 × £18 = £264 |
| ENTERPRISE | unlimited (fair use) | £1,100 | £150 | custom |

Each monthly cap covers the whole allowance at the typical per-video cost, so a customer is not paused before using what they paid for (`catalogue.test.ts` guards this).

> **21.3 tiered video models (2026-10-04), OPERATOR DECISION PENDING.** STANDARD now renders AI clips on the full Seedance 2.0 at 720p and PLUS / Enterprise at 1080p. A typical 30 s short now costs STANDARD £2.33 and PLUS £7.27 (6 clips at 1080p) at USD→GBP 0.75 (£2.41 / £7.63 at 0.79); long form STANDARD 3 min £13.57, PLUS 6 min £61.37. The §P.2 figures above (typical costs, monthly caps, top-up headroom, margins) are **unchanged** because raising the caps to hold the allowance would take STANDARD and PLUS below the 15 % margin-at-cap rule (PLUS below zero). Until the operator decides, the unchanged monthly caps hold about 31 of STANDARD's 40 shorts and 36 of PLUS's 80. Only the per-video budgets (STANDARD £5, PLUS / Enterprise £16 short, £130 long) and the daily caps (STANDARD £20, PLUS £90) were raised so a normal video is not paused. The monthly caps can be raised without a release with `STUDIO_ORG_MONTHLY_CAP_PENCE_<TIER>` (or per organisation in Admin → Organisations → Cost caps). See PROGRESS 21.3 for the arithmetic and options.

| Plan | Price | Net per month | Typical cost | Margin typical | Margin at cap |
|---|---|---|---|---|---|
| BASIC monthly | £29 | 29 × 0.9555 − 0.20 − 2 = £25.51 | £9 | **56.9 %** | (25.51 − 20) / 29 = **19.0 %** |
| STANDARD monthly | £99 | 99 × 0.9555 − 0.20 − 4 = £90.39 | £36.50 | **54.4 %** | (90.39 − 73) / 99 = **17.6 %** |
| PLUS monthly | £349 | 349 × 0.9555 − 0.20 − 8 = £325.27 | £132 | **55.4 %** | (325.27 − 264) / 349 = **17.6 %** |
| BASIC annual | £290 (£24.17/mo) | £21.08 | £9 | 50.0 % | 4.5 % |
| STANDARD annual | £990 (£82.50/mo) | £74.81 | £36.50 | 46.4 % | 2.2 % |
| PLUS annual | £3,490 (£290.83/mo) | £269.87 | £132 | 47.4 % | 2.0 % |
| ENTERPRISE | from £1,500 | £1,393.05 at £1,500 | | | 19.5 % at the £1,100 default cap; ≥ 15 % whenever price ≥ (C + £40.20) / 0.8055 (C = £1,100 → minimum £1,416) |

Annual plans stay positive at the cap but thin (2–5 %): an annual customer who spends the whole cap every month is roughly break-even. At typical use they keep 46–50 %.

Top-up packs (each consumed credit raises the month's cap by its headroom, at least its typical per-video cost):

| Pack | Price | Worst-case cost (headroom) | Margin at worst case |
|---|---|---|---|
| 10 short BASIC | £15 | 10 × £1.00 | 27.6 % |
| 10 short STANDARD | £25 | 10 × £1.75 | 24.8 % |
| 10 short PLUS | £35 | 10 × £2.65 | 19.3 % |
| 2 long STANDARD | £29 | 2 × £10 | 25.9 % |
| 2 long PLUS | £55 | 2 × £20 | 22.5 % |

Trial (unchanged): STANDARD features for 14 days, 5 short + 1 long, at most £15 of provider spend (daily £10), card required, one per organisation and card.

Before raising a cap or lowering a price, recompute the row. Guards in `catalogue.test.ts`: monthly plans ≥ 50 % at typical use and ≥ 15 % at the cap, every price positive at the cap, top-ups > 15 % at worst case, monthly cap ≥ full allowance at typical cost, ENTERPRISE ≥ 15 % at its cap.

History: the 2026-09-29 list (£59 / £209 / £749, caps £40 / £150 / £450 / £3,000, allowances 20 / 60 + 2 / 150 + 8) is in `plans/phase-18.md` §P.2.

## 6. Environment

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (required when `STUDIO_BILLING=stripe`), `STRIPE_PORTAL_CONFIGURATION_ID` (optional), `STUDIO_TRIAL_DAYS` (14), `STUDIO_BILLING_GRACE_DAYS` (7), `STUDIO_QUOTA_MODE` (unset = enforce with Stripe billing), `STUDIO_SALES_EMAIL` (Enterprise "Contact us"). `STUDIO_CANCELLED_RETENTION_DAYS` (90; 0 disables): a paid organisation whose subscription ended stays read-only that long, then the daily `cancelled-org-retention` job (02:15 UTC) emails the owners (`orgDeletionScheduled`) and hands it to the existing purge (30-day grace, then hard delete). Subscribing again stops the clock; a staff override skips the org.
