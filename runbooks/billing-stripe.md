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
   | studio_basic | studio_basic_monthly | £59.00 | monthly |
   | studio_basic | studio_basic_yearly | £590.00 | yearly |
   | studio_standard | studio_standard_monthly | £209.00 | monthly |
   | studio_standard | studio_standard_yearly | £2,090.00 | yearly |
   | studio_plus | studio_plus_monthly | £749.00 | monthly |
   | studio_plus | studio_plus_yearly | £8,239.00 | yearly |
   | studio_enterprise | none (quoted per customer) | from £3,950/month | staff create it |
   | studio_topup_short10_basic | studio_topup_short10_basic | £29.00 | one-time |
   | studio_topup_short10_standard | studio_topup_short10_standard | £39.00 | one-time |
   | studio_topup_short10_plus | studio_topup_short10_plus | £49.00 | one-time |
   | studio_topup_long2_standard | studio_topup_long2_standard | £39.00 | one-time |
   | studio_topup_long2_plus | studio_topup_long2_plus | £89.00 | one-time |

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
- **Staff override** (goodwill, incident): Admin → Billing → Entitlements with a reason and an expiry. Every change is audited (`entitlement.override_set`). Clearing it restores the Stripe-derived value.
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

## 5. Unit economics (every tier profitable at its cost cap)

Assumptions (§P.2): worst-case Stripe fees 4.45 % (3.25 % international card + 0.7 % Billing + 0.5 % Tax) + 20p per invoice; infrastructure and email per org a month BASIC £2, STANDARD £4, PLUS £8, ENTERPRISE £40. Provider spend can never exceed the monthly cost cap (generation pauses at 100 %). Margin at cap = (price × 0.9555 − fixed fee − infra − cap) / price, per month (annual: price ÷ 12, fee ÷ 12). The same formula is in `catalogue.ts` (`grossMarginAtCap`) and pinned by `catalogue.test.ts`.

| Plan | Price | Net per month | Cap | Margin at cap |
|---|---|---|---|---|
| BASIC monthly | £59 | 59 × 0.9555 − 0.20 − 2 = £54.17 | £40 | 24.0 % |
| STANDARD monthly | £209 | 209 × 0.9555 − 0.20 − 4 = £195.50 | £150 | 21.8 % |
| PLUS monthly | £749 | 749 × 0.9555 − 0.20 − 8 = £707.47 | £450 | 34.4 % |
| BASIC annual | £590 (£49.17/mo) | £44.96 | £40 | 10.1 % |
| STANDARD annual | £2,090 (£174.17/mo) | £162.40 | £150 | 7.1 % |
| PLUS annual | £8,239 (£686.58/mo) | £648.02 | £450 | 28.8 % (§P.2 printed 28.0 %; the formula gives 28.8 %) |
| ENTERPRISE | ≥ (C + £40.20) / 0.8055 | | custom C | ≥ 15 % (C = £3,000 → minimum £3,775; list "from £3,950") |

Top-up packs (each consumed credit raises the month's cap by its worst-case cost):

| Pack | Price | Worst-case cost | Margin |
|---|---|---|---|
| 10 short BASIC | £29 | 10 × £2.00 | 26 % |
| 10 short STANDARD | £39 | 10 × £2.50 | 31 % |
| 10 short PLUS | £49 | 10 × £3.00 | 34 % |
| 2 long STANDARD | £39 | 2 × £15 | 18 % |
| 2 long PLUS | £89 | 2 × £30 | 28 % |

Trial: at most £15 of provider spend (daily £10), card required, one per organisation and card.

Before raising a cap or lowering a price, recompute the row: the margin at cap must stay above 0 (and ≥ 15 % for ENTERPRISE).

## 6. Environment

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (required when `STUDIO_BILLING=stripe`), `STRIPE_PORTAL_CONFIGURATION_ID` (optional), `STUDIO_TRIAL_DAYS` (14), `STUDIO_BILLING_GRACE_DAYS` (7), `STUDIO_QUOTA_MODE` (unset = enforce with Stripe billing), `STUDIO_SALES_EMAIL` (Enterprise "Contact us"). `STUDIO_CANCELLED_RETENTION_DAYS` (90; 0 disables): a paid organisation whose subscription ended stays read-only that long, then the daily `cancelled-org-retention` job (02:15 UTC) emails the owners (`orgDeletionScheduled`) and hands it to the existing purge (30-day grace, then hard delete). Subscribing again stops the clock; a staff override skips the org.
