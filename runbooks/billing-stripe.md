# Billing with Stripe (Phase 18 Track C; three plans since 26.1)

Studio sells **three plans — Starter, Growth and Pro** (operator decision 2026-10-09, BACKLOG 26.1; it replaced the 21.5 per-channel plan). Every plan posts to every platform (TikTok, Instagram, YouTube, Facebook, LinkedIn, X); the plans differ in HD videos a month, businesses and seats. The customer chooses a plan and how often to pay (weekly, monthly, yearly), plus one-off **HD video packs**, through Stripe Checkout, Studio's own **Your plan** page (`/settings/billing`: change the plan or the period, cancel, resume), the Stripe Customer Portal (payment method, billing details and invoices only) and Stripe Tax. ENTERPRISE stays by quote. This runbook covers set-up, the 26.1 migration, day-to-day operations, the test-mode E2E, and the unit economics behind the prices.

Code map: `src/lib/studio/billing/*` (plans, catalogue, gateway, entitlements, plan-change, webhook, service, access gate, credits, reconcile, tier-migration), routes `src/app/api/studio/billing/*` (incl. `plan`, `plan/preview`, `plan/cancel`, `plan/resume`, `plan/scheduled`), `src/app/api/billing/stripe/webhook/route.ts`, admin routes `src/app/api/studio/admin/organisations/[id]/entitlements` and `src/app/api/studio/admin/billing/subscriptions`, scripts `scripts/billing/*`.

Stripe API version: **2026-08-26.dahlia**, pinned in `stripe-client.ts` (stripe-node 22.6.2). Docs were read on 2026-09-29 and, for 21.5 (prorations, invoice previews, subscription schedules, pending updates, prices), on 2026-10-04; links are in the source comments.

## 1. What the operator sets up in Stripe

Do it in **test mode first**, then repeat in live mode.

1. **API keys.** Put the secret key in `STRIPE_SECRET_KEY` (a restricted key also works if it can write Customers, Checkout Sessions, Billing Portal Sessions, Subscriptions and Subscription Schedules, create invoice previews, and read Prices, Products, Invoices, Charges, Payment Methods and Events).
2. **Products and prices (26.1 catalogue).**
   - Test mode: `STRIPE_SECRET_KEY=sk_test_… npx tsx scripts/billing/seed-stripe-test.ts --dry-run`, then the same without `--dry-run`. It refuses live keys and is idempotent (an existing product or a matching price is left alone).
   - Live mode: create the same objects in the dashboard. Each price is GBP, tax behaviour **exclusive**, with the exact **lookup key**; the plan prices are **recurring** (standard pricing; the subscription has one item, quantity 1). Product tax code: *Software as a service (SaaS) – business use* (`txcd_10103001`).

   | Product (id in test) | Price lookup key | Amount | Type |
   |---|---|---|---|
   | studio_plan_starter (metadata `studio_tier=STANDARD`, `studio_plan=starter`) | studio_starter_weekly / studio_starter_monthly / studio_starter_yearly | £9.50 / £29.00 / £290.00 | recurring, weekly / monthly / yearly |
   | studio_plan_growth (`studio_plan=growth`) | studio_growth_weekly / studio_growth_monthly / studio_growth_yearly | £22.50 / £69.00 / £690.00 | recurring |
   | studio_plan_pro (`studio_plan=pro`) | studio_pro_weekly / studio_pro_monthly / studio_pro_yearly | £48.50 / £149.00 / £1,490.00 | recurring |
   | studio_pack_hd5 | studio_pack_hd5 | £17.00 (5 HD videos) | one-time |
   | studio_pack_hd15 | studio_pack_hd15 | £45.00 (15 HD videos) | one-time |
   | studio_enterprise | none (quoted per customer) | from £1,500/month | staff create it |

   Weekly = monthly ÷ 4 × 1.3, **rounded up to the next 50p** (£9.425 → £9.50, £22.425 → £22.50, £48.425 → £48.50; `plans.ts`). Yearly = 10 × monthly, paid upfront ("2 months free"). Included HD videos: Starter 8, Growth 20, Pro 45 a calendar month (monthly; yearly gets the same each calendar month); weekly Starter 2, Growth 5, Pro 11 an ISO week (Monday 00:00 UTC). Businesses 1 / 1 / 3, seats 1 / 3 / 10. 23.3: carousels, slideshows, wall of text and hook + demo count as ¼ of a video, a UGC actor video as 2. Long videos are not part of any plan. Packs: valid 3 months, used after the plan's videos.

   The 21.5 per-channel prices (`studio_channel_*`), the old tier prices (`studio_basic_*`, `studio_standard_*`, `studio_plus_*`) and top-ups (`studio_topup_*`) are no longer sold: Studio still maps them (a subscription on them keeps working: a channel price by its quantity, 1 → Starter, 2–3 → Growth, 4+ → Pro), so **archive them only after the 26.1 migration (§1a)**.
3. **Customer Portal.** `STRIPE_SECRET_KEY=… APP_URL=https://<host> npx tsx scripts/billing/portal-config.ts` (or `--update bpc_…` / with `STRIPE_PORTAL_CONFIGURATION_ID` set, which updates in place). 21.5: the portal offers **payment methods, billing details, tax ids and invoices only**; subscription update and cancel are switched **off**, because plan and period changes, cancel and resume happen on Your plan with one set of rules and a preview. Put the printed id in `STRIPE_PORTAL_CONFIGURATION_ID`. **An existing configuration must be updated** (it still offers the old tier switching until you re-run with `--update`).
4. **Webhook endpoint.** `https://<host>/api/billing/stripe/webhook`, API version 2026-08-26.dahlia, with these events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `customer.subscription.trial_will_end`, `subscription_schedule.created`, `subscription_schedule.updated`, `subscription_schedule.released`, `subscription_schedule.canceled`, `subscription_schedule.completed`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `customer.updated`, `charge.refunded`, `charge.dispute.created`.
   **21.5: add the five `subscription_schedule.*` events** to an existing endpoint (a downgrade waiting for the period end is a schedule; without them Studio still learns of it on the next `customer.subscription.updated` and the nightly reconcile). Put its signing secret in `STRIPE_WEBHOOK_SECRET`. The path is not behind Cloudflare challenge rules and needs no Caddy route.
5. **Stripe Tax.** Turn on Stripe Tax; add the UK VAT registration (and EU OSS if selling to EU consumers). Prices are tax-exclusive; the pricing page says "excl. VAT". Checkout collects the billing address and tax ids.
6. **Dunning.** Billing → *Manage failed payments*: Smart Retries on; after the last retry **mark the subscription unpaid** (recommended) or cancel it — both make the organisation read-only. Turn on Stripe's failed-payment and card-expiry emails. Studio adds its own in-app banner and owner emails (Track B templates).
7. **Trials.** Studio sets `trial_period_days` itself (any period, once per organisation and card). Stripe's "trial ending" reminder emails are optional; Studio sends `trialEnding` on `customer.subscription.trial_will_end`.
8. **Proration.** Nothing to set in the dashboard: Studio sends `proration_behavior=always_invoice` with `payment_behavior=pending_if_incomplete` on every upgrade (a higher plan, or a longer period on the same plan, is invoiced at once and applied only once paid) and schedules downgrades for the period end. Leave the account's default proration as it is; Studio never relies on it.
9. **Branding** for Checkout and the portal (logo, colours, support email and URL).

## 1a. Moving to the three plans (26.1), in this order

Production billing is still Stripe **test mode**. Run against test mode only (the scripts refuse live keys); repeat the dashboard steps for live mode when it goes live.

1. **Deploy** the 26.1 build. There is no database migration: the plan is derived from the Stripe lookup key (old org_entitlements rows that stored a channel count are read as the mapped plan).
2. **Catalogue:** `STRIPE_SECRET_KEY=sk_test_… npx tsx scripts/billing/seed-stripe-test.ts --dry-run`, then without `--dry-run`. It creates the three plan products and nine prices, and moves the pack lookup keys to £17 / £45 (`transfer_lookup_key`; pack buyers keep what they bought).
3. **Portal:** no change (it already offers payment details and invoices only).
4. **Migrate the subscriptions:** `STRIPE_SECRET_KEY=sk_test_… DATABASE_URL=… npx tsx scripts/billing/migrate-to-tiers.ts` (dry run: prints each subscription and what it would do), then the same with `--apply`. A 21.5 channel subscription moves to the same interval of 1 channel → Starter, 2–3 → Growth, 4+ → Pro; any old tier price left moves Basic → Starter, Standard → Growth, Plus → Pro. Quantity 1, `proration_behavior=none` (the new amount applies from the next invoice; same interval, so the billing period is unchanged); a pending end-of-period schedule is released first; each subscription is stored at once. Idempotent: subscriptions already on a plan price, ended ones and ENTERPRISE are skipped; re-running is safe.
5. Check Admin → Billing → Subscriptions (every row shows its plan) and a few organisations' Your plan pages; then **archive** the `studio_channel_*` prices (and any old tier and top-up prices) in the dashboard. Credits from earlier packs keep working until they expire.

History: the 21.5 move (2026-10-04) put Basic / Standard / Plus on 1 / 3 / 6 channels with `migrate-channel-plans.ts`, now removed (`migrate-to-tiers.ts` also handles any old tier price left).

## 2. How it works

- **Catalogue.** `plans.ts` holds the three plans (reference prices, videos a month / a week, businesses, seats), the allowance windows, the internal cost caps and the change rules; `catalogue.ts` keeps the internal tier matrix (every plan is **STANDARD**: routing, render quality, gates — the same HD video on every plan) and the packs. Amounts live in Stripe and are read with `prices.list(lookup_keys, expand data.product)` (11 keys, two requests of at most 10), cached 10 minutes. Env overrides (`STUDIO_QUOTA_*`, `STUDIO_IMAGE_GEN_MONTHLY_CAP_*`, `STUDIO_MUSIC_MIN_TIER`, `STUDIO_VOICE_CLONE_MIN_TIER`) still win for tiers; a plan's own allowance and caps come from the plan (`STUDIO_ORG_*_CAP_PENCE_STANDARD` does not apply to plan subscriptions; a staff cost-cap override still does).
- **Entitlements.** Every webhook re-fetches the subscription from the API (with its schedule) and stores it (`studio.subscriptions`, incl. quantity, interval and any change waiting for the period end); `entitlementsFromSubscription()` turns it into `org_entitlements` (tier, access, source, and `plan` + `interval` in `overrides.derived`; rows written before 26.1 hold `channels`, read as the mapped plan). Seats and businesses come from the plan (custom limits still win). The reader caches for 30 s and applies the grace clock and admin overrides (which may set the plan and interval) at read time.
- **Your plan** (`plan-change.ts`). Upgrades — a higher plan (Starter → Growth → Pro, whatever the interval), or a longer period on the same plan (week → month → year) — apply **now**: the preview is `invoices.createPreview` with the new item and `proration_behavior=always_invoice`, and the confirmed change sends the same `proration_date` with `payment_behavior=pending_if_incomplete`, so the customer pays exactly what was shown and nothing changes if the payment fails ("Your payment didn't go through"). Downgrades — a lower plan, or a shorter period on the same plan — apply at the **end of the period**: a subscription schedule from the subscription, current phase kept as it is (dates, items, tax, payment method, trial) plus one phase with the new price (quantity 1), `end_behavior=release`. One pending change at a time: a new change replaces it, an upgrade drops it, "Keep my current plan" releases it. A **trialing** subscription changes at once with no proration (nothing is charged until the trial ends). Cancel = `cancel_at_period_end` (a scheduled change is dropped first); resume undoes it. After each write Studio re-fetches and stores the subscription at once; the webhook then arrives and changes nothing.
- **Platforms.** Every plan publishes to every platform: there is no channel limit (the 21.5 `channel_limit` check is gone).
- **Access gate.** `none` (never paid): set-up only; generate, publish and scan answer 402 `plan_required`. `read_only`: every mutation outside billing / account / org / members / notifications / export / downloads / deletes answers 402 `billing_required`. Workers check at job start: spend jobs stop, publish jobs are **held** (`metadata.billingHold`) and the 17.2 re-drive sweep publishes them once access is full again.
- **Quotas.** Standalone enforces quotas by default. The allowance is the plan's videos a calendar month (Starter 8, Growth 20, Pro 45; monthly and yearly) or an ISO week (2 / 5 / 11; weekly); no long videos. 23.3: usage is counted in integer quarters of a video (`billing/allowance-units.ts`; a quick post 1, a video 4, a UGC actor video 8; 8 videos = 32 quarters) and shown as videos (5.5 of 8). The check runs under a Postgres advisory lock per (organisation, window) and reserves the slot, so concurrent generates cannot both take the last one.
- **Video packs.** Paid `mode=payment` Checkout sessions create `usage_credits` (3 months, FIFO, once per session). A credit is spent only when the plan allowance is used up (one per project and calendar month) and raises that month's cost cap by £2.50. 23.3: pack balances are in quarters (`usage_credits.remainingQuarters`; `usage_credit_uses.quarters` records what each use took, so a release or refund gives back exactly that); the video columns `quantity` / `remaining` are legacy, written at purchase only. A refund removes the refunded share of unused credits. Old top-up credits keep their kind and headroom until they expire.
- **Costs are internal.** No customer screen or customer API shows generation cost, spend or caps; staff see them in the Admin Centre.
- **Trial abuse.** One trial per organisation; the card fingerprint is stored in `trial_fingerprints`; a card that already trialled for another organisation ends the new trial at once (`trial_end=now`). The trial (7 days) includes 2 HD videos and its provider spend is capped internally at £10 a day and £15 in total.
- **Safety nets.** `sweep-stripe-events` (every 10 min) re-processes events whose processing failed (they stay `processedAt NULL`, `lastError` says why; after 8 attempts a person looks). `reconcile-subscriptions` (03:15 UTC) stores every Stripe subscription again (re-fetching those with a schedule) and recomputes every organisation.
## 3. Operations

- **Change a price with no deploy:** create a new Price on the same product with the same lookup key and "transfer lookup key" ticked (or change `STUDIO_PLANS` in `plans.ts` and re-run the seed script in test mode). The pricing page and Your plan pick it up within 10 minutes; plan changes use the new price. Existing subscribers keep their old price until migrated in Stripe. **Re-check the margin maths in §5 first.**
- **ENTERPRISE:** create the subscription in Stripe on the `studio_enterprise` product (metadata `studio_tier=ENTERPRISE`) for the organisation's customer (it exists once the org opened Checkout once; otherwise create one with metadata `organisationId` and add the row via support). Then Admin → Billing → Entitlements: tier ENTERPRISE, custom limits, the agreed monthly price (the form refuses a price below the minimum for the organisation's monthly cost cap), and a reason. Set the custom cost cap in the existing Cost caps panel **before** the price, because the minimum is computed from it.
- **Staff override** (goodwill, incident): Admin → Organisations → search → Open → **Plan, access and trial** (or Admin → Billing → Entitlements by organisation id) with a reason and an expiry. Every change is audited (`entitlement.override_set`). Clearing it restores the Stripe-derived value.
- **Change an organisation's plan, access or caps (20.27).** Admin Centre (platform staff or superadmin, 2FA on) → **Organisations** tab → search by name, slug or id (the list shows plan, access, trial, subscription status and AI cost this month, 50 a page) → **Open**.
  - *Plan, access and trial* shows the effective tier, access and source, the trial (state, start and end, AI cost since it started against its £15 total and £10 a day), the stored row, the current override and the subscriptions.
  - *Set an override*: tier (Basic / Standard / Plus / Enterprise; Enterprise needs the agreed monthly price, at least the minimum shown), access (Full / Read-only / None), **plan (Starter / Growth / Pro) and period (weekly / monthly / yearly)** — these set the allowance, the internal caps, the seats and the businesses without touching Stripe — optional expiry, required reason. Access None or Read-only asks for confirmation. *Remove the override* (reason required) goes back to the Stripe-derived plan.
  - *Cost caps* (same page): daily and monthly £ override with a reason; **Clear back to plan default** removes both. Workers pick changes up within 30 s.
- **End a trial (20.27).** A trial's caps (£10 a day, £15 in total) apply instead of the plan's caps *and instead of any cost-cap override* while the trial runs, so raising cost caps alone does not help a trialing organisation. Any active staff override pauses the trial (source becomes `admin`, no trial caps), but the caps come back if the override expires or is removed while Stripe still says `trialing`. To end it for good: in *Set an override* tick **End the trial now** (shown only while a trial is running or paused), add the tier (e.g. Plus) and a reason, Save, and confirm. This stores `overrides.trial.endedAt` / `endedByUserId`; from then on the organisation never gets trial caps or the trial allowance again, even without an override, and the plan tier's caps (plus any cost-cap override) apply. Audited in `entitlement.override_set` with `trialEnded`. Stripe is **not** changed: the Stripe trial still ends, and the first invoice is charged, on its own date (cancel or change the subscription in Stripe if that should not happen).
- **Refunds:** the terms give no refunds for part-used periods; refund in Stripe when you decide to. A pack refund removes the unused credits automatically; a subscription refund does not change access (cancel the subscription if access should end).
- **A customer's plan change failed to pay:** the subscription has a `pending_update` (Your plan says the change is waiting for payment). It applies by itself once the invoice is paid (card updated in the portal), or expires after 23 hours with nothing changed.
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
   It creates a test clock and a customer, subscribes to Growth monthly with a 7-day trial, and advances the clock: **trial → active → failed payment (pm_card_chargeCustomerFail) → grace (past_due, full) → read-only → recovered (pm_card_visa, invoices paid)**, checking Studio's stored entitlements after each step, then deletes the clock and its rows.
5. Record the result and date in PROGRESS.md.

## 5. Unit economics (three plans, 2026-10-09)

Assumptions: worst-case Stripe fees 4.45 % (3.25 % international card + 0.7 % Billing + 0.5 % Tax) + 20p per invoice (weekly plans pay it 52 ÷ 12 times a month); infrastructure and email £4 per organisation a month (STANDARD). Typical provider cost of a 30 s short: **241p** (Seedance 2.0 full at 720p on every plan). Typical use is 50 % of the allowance. Provider spend cannot exceed the monthly cost cap (generation pauses at 100 %).

Internal caps (`planCostCapsPence`, never shown to customers): monthly = the most videos one calendar month can hold (the plan's videos a month; weekly the videos a week × 5 ISO weeks) × 241p × 1.25; daily = half of that. Starter monthly: £24.10 a month, £12.05 a day; Growth £60.25 / £30.13; Pro £135.57 / £67.79; Starter weekly £30.13 / £15.07, Growth weekly £75.32, Pro weekly £165.69. A staff cost-cap override still wins.

Margin = (monthly-equivalent price × 0.9555 − invoice fees − £4 − provider spend) / price. Same formula as `planGrossMargin` in `catalogue.ts`, pinned by `catalogue.test.ts`.

| Plan | Price a month | Margin at typical use | Margin at the cap |
|---|---|---|---|
| Starter monthly | £29.00 | 47.8 % | **−2.0 %** |
| Growth monthly | £69.00 | 54.5 % | 2.1 % |
| Pro monthly | £149.00 | 56.3 % | 1.7 % |
| Starter weekly | £41.17 (£9.50 × 52 ÷ 12) | 58.4 % | 10.5 % |
| Growth weekly | £97.50 | 63.8 % | 13.3 % |
| Pro weekly | £210.17 | 65.9 % | 14.4 % |
| Starter yearly | £24.17 (£290 ÷ 12) | 39.0 % | **−20.8 %** |
| Growth yearly | £57.50 | 46.7 % | **−16.2 %** |
| Pro yearly | £124.17 | 48.6 % | **−16.9 %** |

Every plan is profitable at typical use. **At the cap** (every video costing the cap rate of ~£3.01), Starter monthly and every yearly plan lose money, and Growth / Pro monthly are close to break-even: the caps are sized so a customer is never paused before using the allowance they paid for, and yearly is 10 months' price for 12 months of videos. If real costs drift towards the cap, raise the yearly price or lower the headroom.

HD video packs (each consumed credit raises that month's cap by £2.50):

| Pack | Price | Margin if every video costs £2.50 | Margin at 241p |
|---|---|---|---|
| 5 HD videos | £17 | 20.8 % | 23.5 % |
| 15 HD videos | £45 | 11.8 % | 14.8 % |

Trial: 7 days, card required, one per organisation and card; 2 HD videos (no long video); internally at most £15 of provider spend (daily £10).

ENTERPRISE (unchanged): from £1,500 a month; the admin console refuses a price below `enterpriseMinimumMonthlyPricePence` for the organisation's monthly cost cap (15 % margin at the cap; £1,100 cap → £1,416).

History: the 21.5 per-channel plan (2026-10-04: £29 per channel a month, 8 videos per channel, 1–6 channels; packs £15 / £39) is in PROGRESS.md 21.5; the 2026-09-30 tier list (£29 / £99 / £349, 20 / 40 + 1 / 80 + 4 videos, caps £20 / £73 / £264) and the 2026-09-29 list (£59 / £209 / £749) are in `plans/phase-18.md` §P.2.
## 6. Environment

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (required when `STUDIO_BILLING=stripe`), `STRIPE_PORTAL_CONFIGURATION_ID` (optional), `STUDIO_TRIAL_DAYS` (7), `STUDIO_BILLING_GRACE_DAYS` (7), `STUDIO_QUOTA_MODE` (unset = enforce with Stripe billing), `STUDIO_SALES_EMAIL` (Enterprise contact for staff and the admin console). `STUDIO_CANCELLED_RETENTION_DAYS` (90; 0 disables): a paid organisation whose subscription ended stays read-only that long, then the daily `cancelled-org-retention` job (02:15 UTC) emails the owners (`orgDeletionScheduled`) and hands it to the existing purge (30-day grace, then hard delete). Subscribing again stops the clock; a staff override skips the org.
