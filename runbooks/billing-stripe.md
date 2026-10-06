# Billing with Stripe (Phase 18 Track C; per-channel pricing since 21.5)

Studio sells **one plan, per channel** (operator decision 2026-10-04, BACKLOG 21.5): the customer chooses how many channels (social platforms: TikTok, Instagram, YouTube Shorts, Facebook, LinkedIn, X), 1 to 6, and how often to pay (weekly, monthly, yearly), plus one-off **HD video packs**, through Stripe Checkout, Studio's own **Your plan** page (`/settings/billing`: change channels or the period, cancel, resume), the Stripe Customer Portal (payment method, billing details and invoices only) and Stripe Tax. ENTERPRISE stays by quote. This runbook covers set-up, the 21.5 migration, day-to-day operations, the test-mode E2E, and the unit economics behind the prices.

Code map: `src/lib/studio/billing/*` (channel-plan, catalogue, gateway, entitlements, plan-change, channels, webhook, service, access gate, credits, reconcile, channel-migration), routes `src/app/api/studio/billing/*` (incl. `plan`, `plan/preview`, `plan/cancel`, `plan/resume`, `plan/scheduled`), `src/app/api/billing/stripe/webhook/route.ts`, admin routes `src/app/api/studio/admin/organisations/[id]/entitlements` and `src/app/api/studio/admin/billing/subscriptions`, scripts `scripts/billing/*`.

Stripe API version: **2026-08-26.dahlia**, pinned in `stripe-client.ts` (stripe-node 22.6.2). Docs were read on 2026-09-29 and, for 21.5 (prorations, invoice previews, subscription schedules, pending updates, prices), on 2026-10-04; links are in the source comments.

## 1. What the operator sets up in Stripe

Do it in **test mode first**, then repeat in live mode.

1. **API keys.** Put the secret key in `STRIPE_SECRET_KEY` (a restricted key also works if it can write Customers, Checkout Sessions, Billing Portal Sessions, Subscriptions and Subscription Schedules, create invoice previews, and read Prices, Products, Invoices, Charges, Payment Methods and Events).
2. **Products and prices (21.5 catalogue).**
   - Test mode: `STRIPE_SECRET_KEY=sk_test_… npx tsx scripts/billing/seed-stripe-test.ts --dry-run`, then the same without `--dry-run`. It refuses live keys and is idempotent (an existing product or a matching price is left alone).
   - Live mode: create the same objects in the dashboard. Each price is GBP, tax behaviour **exclusive**, with the exact **lookup key**; the channel prices are **recurring, per unit** (standard pricing; the subscription's quantity is the number of channels). Product tax code: *Software as a service (SaaS) – business use* (`txcd_10103001`).

   | Product (id in test) | Price lookup key | Amount | Type |
   |---|---|---|---|
   | studio_channel (metadata `studio_tier=STANDARD`) | studio_channel_weekly | £9.50 per channel | recurring, weekly |
   | studio_channel | studio_channel_monthly | £29.00 per channel | recurring, monthly |
   | studio_channel | studio_channel_yearly | £290.00 per channel | recurring, yearly |
   | studio_pack_hd5 | studio_pack_hd5 | £15.00 (5 HD videos) | one-time |
   | studio_pack_hd15 | studio_pack_hd15 | £39.00 (15 HD videos) | one-time |
   | studio_enterprise | none (quoted per customer) | from £1,500/month | staff create it |

   Weekly = monthly ÷ 4 × 1.3 = £9.425, **rounded up to the next 50p** = £9.50 (`channel-plan.ts`). Yearly = 10 × monthly, paid upfront ("2 months free"). Included: 8 videos per channel a month; weekly 2 per channel a week (counted per ISO week, Monday 00:00 UTC); yearly 96 per channel a year, released as 8 per calendar month. 23.3: carousels, slideshows, wall of text and hook + demo count as ¼ of a video (up to 32 quick posts per channel a month), a UGC actor video as 2. Long videos are not part of the plan. Packs: usable on any channel, valid 3 months, used after the plan's videos.

   The old tier prices (`studio_basic_*`, `studio_standard_*`, `studio_plus_*`) and top-ups (`studio_topup_*`) are no longer sold: Studio still maps them (a subscription on them keeps working), so **archive them only after the 21.5 migration (§1a)**.
3. **Customer Portal.** `STRIPE_SECRET_KEY=… APP_URL=https://<host> npx tsx scripts/billing/portal-config.ts` (or `--update bpc_…` / with `STRIPE_PORTAL_CONFIGURATION_ID` set, which updates in place). 21.5: the portal offers **payment methods, billing details, tax ids and invoices only**; subscription update and cancel are switched **off**, because channel and period changes, cancel and resume happen on Your plan with one set of rules and a preview. Put the printed id in `STRIPE_PORTAL_CONFIGURATION_ID`. **An existing configuration must be updated** (it still offers the old tier switching until you re-run with `--update`).
4. **Webhook endpoint.** `https://<host>/api/billing/stripe/webhook`, API version 2026-08-26.dahlia, with these events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `customer.subscription.trial_will_end`, `subscription_schedule.created`, `subscription_schedule.updated`, `subscription_schedule.released`, `subscription_schedule.canceled`, `subscription_schedule.completed`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `customer.updated`, `charge.refunded`, `charge.dispute.created`.
   **21.5: add the five `subscription_schedule.*` events** to an existing endpoint (a downgrade waiting for the period end is a schedule; without them Studio still learns of it on the next `customer.subscription.updated` and the nightly reconcile). Put its signing secret in `STRIPE_WEBHOOK_SECRET`. The path is not behind Cloudflare challenge rules and needs no Caddy route.
5. **Stripe Tax.** Turn on Stripe Tax; add the UK VAT registration (and EU OSS if selling to EU consumers). Prices are tax-exclusive; the pricing page says "excl. VAT". Checkout collects the billing address and tax ids.
6. **Dunning.** Billing → *Manage failed payments*: Smart Retries on; after the last retry **mark the subscription unpaid** (recommended) or cancel it — both make the organisation read-only. Turn on Stripe's failed-payment and card-expiry emails. Studio adds its own in-app banner and owner emails (Track B templates).
7. **Trials.** Studio sets `trial_period_days` itself (any period, once per organisation and card). Stripe's "trial ending" reminder emails are optional; Studio sends `trialEnding` on `customer.subscription.trial_will_end`.
8. **Proration.** Nothing to set in the dashboard: Studio sends `proration_behavior=always_invoice` with `payment_behavior=pending_if_incomplete` on every upgrade (more channels or a longer period are invoiced at once and applied only once paid) and schedules downgrades for the period end. Leave the account's default proration as it is; Studio never relies on it.
9. **Branding** for Checkout and the portal (logo, colours, support email and URL).

## 1a. Moving to per-channel pricing (21.5), in this order

All existing subscriptions are Stripe **test mode**. Run against test mode only (the scripts refuse live keys); repeat the dashboard steps for live mode when it goes live.

1. **Deploy** the 21.5 build. The Prisma migration `20261008010000_channel_plans` (expand-only: `subscriptions.scheduleId`, `pendingQuantity`, `pendingLookupKey`, `pendingEffectiveAt`, `pendingUpdate`) runs with `prisma migrate deploy` as usual.
2. **Catalogue:** `STRIPE_SECRET_KEY=sk_test_… npx tsx scripts/billing/seed-stripe-test.ts --dry-run`, then without `--dry-run`.
3. **Portal:** `STRIPE_SECRET_KEY=sk_test_… APP_URL=https://<host> npx tsx scripts/billing/portal-config.ts --update <bpc_…>` (or without `--update` to create one; put the id in `STRIPE_PORTAL_CONFIGURATION_ID`).
4. **Webhook:** add the five `subscription_schedule.*` events (§1.4).
5. **Migrate the old subscriptions:** `STRIPE_SECRET_KEY=sk_test_… DATABASE_URL=… npx tsx scripts/billing/migrate-channel-plans.ts` (dry run: prints each subscription and what it would do), then the same with `--apply`. Basic → 1 channel, Standard → 3, Plus → 6, all on `studio_channel_monthly` (quantity = channels), `proration_behavior=none`; a schedule left by the old portal is released first; each subscription is re-fetched and stored at once (Studio shows the channels immediately). Idempotent: subscriptions already on a channel price, ended ones and ENTERPRISE are skipped; re-running is safe. A **yearly** legacy subscription also moves to monthly; because the interval changes, Stripe starts a new monthly period on the day of the move and invoices it then.
6. Check Admin → Billing → Subscriptions (every row shows channels) and a few organisations' Your plan pages; then **archive** the old tier and top-up prices in the dashboard. Credits from old top-ups keep working until they expire.

## 2. How it works

- **Catalogue.** `channel-plan.ts` holds the per-channel prices (reference), allowance per channel and period, the allowance windows, the internal cost caps and the change rules; `catalogue.ts` keeps the internal tier matrix (every channel subscription is **STANDARD**: routing, render quality, gates) and the packs. Amounts live in Stripe and are read with `prices.list(lookup_keys, expand data.product)`, cached 10 minutes. Env overrides (`STUDIO_QUOTA_*`, `STUDIO_IMAGE_GEN_MONTHLY_CAP_*`, `STUDIO_MUSIC_MIN_TIER`, `STUDIO_VOICE_CLONE_MIN_TIER`) still win for tiers; a channel plan's own allowance and caps come from the channels (`STUDIO_ORG_*_CAP_PENCE_STANDARD` no longer applies to channel subscriptions; a staff cost-cap override still does).
- **Entitlements.** Every webhook re-fetches the subscription from the API (with its schedule) and stores it (`studio.subscriptions`, incl. quantity, interval and any change waiting for the period end); `entitlementsFromSubscription()` turns it into `org_entitlements` (tier, access, source, and `channels` + `interval` in `overrides.derived`). The reader caches for 30 s and applies the grace clock and admin overrides (which may set channels and interval) at read time.
- **Your plan** (`plan-change.ts`). Upgrades — more channels, or a longer period (week → month → year) — apply **now**: the preview is `invoices.createPreview` with the new item and `proration_behavior=always_invoice`, and the confirmed change sends the same `proration_date` with `payment_behavior=pending_if_incomplete`, so the customer pays exactly what was shown and nothing changes if the payment fails ("Your payment didn't go through"). Downgrades — fewer channels, or a shorter period — apply at the **end of the period**: a subscription schedule from the subscription, current phase kept as it is (dates, items, tax, payment method, trial) plus one phase with the new price and quantity, `end_behavior=release`. One pending change at a time: a new change replaces it, an upgrade drops it, "Keep my current plan" releases it. A **trialing** subscription changes at once with no proration (nothing is charged until the trial ends). Cancel = `cancel_at_period_end` (a scheduled change is dropped first); resume undoes it. After each write Studio re-fetches and stores the subscription at once; the webhook then arrives and changes nothing.
- **Channel limit** (`channels.ts`). Connecting is never blocked; only the paid number of channels publish — the platforms connected first (oldest non-revoked connection per platform). `createPublication` (every route to publishing: the Publish tab, auto-publish, schedules, drip queue, month plans) answers 403 `channel_limit` past the limit; the app opens "Add a channel to publish here"; Connections and Your plan say which platforms will not publish.
- **Access gate.** `none` (never paid): set-up only; generate, publish and scan answer 402 `plan_required`. `read_only`: every mutation outside billing / account / org / members / notifications / export / downloads / deletes answers 402 `billing_required`. Workers check at job start: spend jobs stop, publish jobs are **held** (`metadata.billingHold`) and the 17.2 re-drive sweep publishes them once access is full again.
- **Quotas.** Standalone enforces quotas by default. The allowance is `channels × 8` a calendar month (monthly and yearly) or `channels × 2` an ISO week (weekly); no long videos. 23.3: usage is counted in integer quarters of a video (`billing/allowance-units.ts`; a quick post 1, a video 4, a UGC actor video 8; 8 videos = 32 quarters) and shown as videos (5.5 of 8). The check runs under a Postgres advisory lock per (organisation, window) and reserves the slot, so concurrent generates cannot both take the last one.
- **Video packs.** Paid `mode=payment` Checkout sessions create `usage_credits` (3 months, FIFO, once per session). A credit is spent only when the plan allowance is used up (one per project and calendar month) and raises that month's cost cap by £2.50. 23.3: pack balances are in quarters (`usage_credits.remainingQuarters`; `usage_credit_uses.quarters` records what each use took, so a release or refund gives back exactly that); the video columns `quantity` / `remaining` are legacy, written at purchase only. A refund removes the refunded share of unused credits. Old top-up credits keep their kind and headroom until they expire.
- **Costs are internal.** No customer screen or customer API shows generation cost, spend or caps; staff see them in the Admin Centre.
- **Trial abuse.** One trial per organisation; the card fingerprint is stored in `trial_fingerprints`; a card that already trialled for another organisation ends the new trial at once (`trial_end=now`). The trial includes 5 videos and its provider spend is capped internally at £10 a day and £15 in total.
- **Safety nets.** `sweep-stripe-events` (every 10 min) re-processes events whose processing failed (they stay `processedAt NULL`, `lastError` says why; after 8 attempts a person looks). `reconcile-subscriptions` (03:15 UTC) stores every Stripe subscription again (re-fetching those with a schedule) and recomputes every organisation.
## 3. Operations

- **Change a price with no deploy:** create a new Price on the same product with the same lookup key and "transfer lookup key" ticked (or change `CHANNEL_PRICE_PENCE` and re-run the seed script in test mode). The pricing page and Your plan pick it up within 10 minutes; plan changes use the new price. Existing subscribers keep their old price until migrated in Stripe. **Re-check the margin maths in §5 first.**
- **ENTERPRISE:** create the subscription in Stripe on the `studio_enterprise` product (metadata `studio_tier=ENTERPRISE`) for the organisation's customer (it exists once the org opened Checkout once; otherwise create one with metadata `organisationId` and add the row via support). Then Admin → Billing → Entitlements: tier ENTERPRISE, custom limits, the agreed monthly price (the form refuses a price below the minimum for the organisation's monthly cost cap), and a reason. Set the custom cost cap in the existing Cost caps panel **before** the price, because the minimum is computed from it.
- **Staff override** (goodwill, incident): Admin → Organisations → search → Open → **Plan, access and trial** (or Admin → Billing → Entitlements by organisation id) with a reason and an expiry. Every change is audited (`entitlement.override_set`). Clearing it restores the Stripe-derived value.
- **Change an organisation's plan, access or caps (20.27).** Admin Centre (platform staff or superadmin, 2FA on) → **Organisations** tab → search by name, slug or id (the list shows plan, access, trial, subscription status and AI cost this month, 50 a page) → **Open**.
  - *Plan, access and trial* shows the effective tier, access and source, the trial (state, start and end, AI cost since it started against its £15 total and £10 a day), the stored row, the current override and the subscriptions.
  - *Set an override*: tier (Basic / Standard / Plus / Enterprise; Enterprise needs the agreed monthly price, at least the minimum shown), access (Full / Read-only / None), **channels (1–6) and period (weekly / monthly / yearly)** — these set the allowance, the internal caps and the channel limit without touching Stripe — optional expiry, required reason. Access None or Read-only asks for confirmation. *Remove the override* (reason required) goes back to the Stripe-derived plan.
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
   It creates a test clock and a customer, subscribes to 2 channels monthly with a 14-day trial, and advances the clock: **trial → active → failed payment (pm_card_chargeCustomerFail) → grace (past_due, full) → read-only → recovered (pm_card_visa, invoices paid)**, checking Studio's stored entitlements after each step, then deletes the clock and its rows.
5. Record the result and date in PROGRESS.md.

## 5. Unit economics (per-channel pricing, 2026-10-04)

Assumptions: worst-case Stripe fees 4.45 % (3.25 % international card + 0.7 % Billing + 0.5 % Tax) + 20p per invoice (weekly plans pay it 52 ÷ 12 times a month); infrastructure and email £4 per organisation a month (STANDARD). Typical provider cost of a 30 s short: **241p** (Seedance 2.0 full at 720p on every tier, p21-tiered-models; it was 141p on Mini). Typical use is 50 % of the allowance. Provider spend cannot exceed the monthly cost cap (generation pauses at 100 %).

Internal caps (`channelCostCapsPence`, never shown to customers): monthly = the most videos one calendar month can hold (8 × channels; weekly 2 × channels × 5 ISO weeks) × 241p × 1.25; daily = half of that. 1 channel monthly: £24.10 a month, £12.05 a day; 6 channels monthly: £144.60 / £72.30; 1 channel weekly: £30.13 / £15.07. A staff cost-cap override still wins.

Margin = (monthly-equivalent price × 0.9555 − invoice fees − £4 − provider spend) / price. Same formula as `channelGrossMargin` in `catalogue.ts`, pinned by `catalogue.test.ts`.

| Plan | Price a month | Margin at typical use | Margin at the cap |
|---|---|---|---|
| 1 channel monthly | £29.00 | 47.8 % | **−2.0 %** |
| 3 channels monthly | £87.00 | 57.5 % | 7.6 % |
| 6 channels monthly | £174.00 | 59.9 % | 10.0 % |
| 1 channel weekly | £41.17 (£9.50 × 52 ÷ 12) | 58.4 % | 10.5 % |
| 3 channels weekly | £123.50 | 66.2 % | 18.4 % |
| 6 channels weekly | £247.00 | 68.2 % | 20.4 % |
| 1 channel yearly | £24.17 (£290 ÷ 12) | 39.0 % | **−20.8 %** |
| 3 channels yearly | £72.50 | 50.1 % | **−9.7 %** |
| 6 channels yearly | £145.00 | 52.9 % | **−6.9 %** |

Every plan is profitable at typical use. **At the cap** (every video costing the cap rate of ~£3.01), a single monthly channel and every yearly plan lose money: the caps are sized so a customer is never paused before using the allowance they paid for, and yearly is 10 months' price for 12 months of videos. If real costs drift towards the cap, raise the yearly price (11 × monthly is break-even at the cap for 3+ channels) or lower the headroom.

HD video packs (each consumed credit raises that month's cap by £2.50):

| Pack | Price | Margin if every video costs £2.50 | Margin at 241p |
|---|---|---|---|
| 5 HD videos | £15 | 10.9 % | 13.9 % |
| 15 HD videos | £39 | **−1.1 %** | 2.3 % |

The 15-pack is thin: at the cap rate it is slightly below cost. £45 would keep ~15 %.

Trial (unchanged): 14 days, card required, one per organisation and card; 5 videos (no long video); internally at most £15 of provider spend (daily £10).

ENTERPRISE (unchanged): from £1,500 a month; the admin console refuses a price below `enterpriseMinimumMonthlyPricePence` for the organisation's monthly cost cap (15 % margin at the cap; £1,100 cap → £1,416).

History: the 2026-09-30 tier list (£29 / £99 / £349, 20 / 40 + 1 / 80 + 4 videos, caps £20 / £73 / £264) and the 2026-09-29 list (£59 / £209 / £749) are in `plans/phase-18.md` §P.2.
## 6. Environment

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (required when `STUDIO_BILLING=stripe`), `STRIPE_PORTAL_CONFIGURATION_ID` (optional), `STUDIO_TRIAL_DAYS` (14), `STUDIO_BILLING_GRACE_DAYS` (7), `STUDIO_QUOTA_MODE` (unset = enforce with Stripe billing), `STUDIO_SALES_EMAIL` (Enterprise contact for staff and the admin console). `STUDIO_CANCELLED_RETENTION_DAYS` (90; 0 disables): a paid organisation whose subscription ended stays read-only that long, then the daily `cancelled-org-retention` job (02:15 UTC) emails the owners (`orgDeletionScheduled`) and hands it to the existing purge (30-day grace, then hard delete). Subscribing again stops the clock; a staff override skips the org.
