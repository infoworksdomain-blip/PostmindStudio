# Website scan blocked by anti-bot measures (priority risk 6)

| | |
| --- | --- |
| **Metric** | Scan failure rate per target: `website_scans` rows in the failed state, grouped by domain and organisation. |
| **Threshold** | More than 10% failures for any customer. |
| **Escalation** | On-call engineer, then Customer Success. |

## Controls that exist

- The scanner fetches only public addresses (SSRF-safe).
- Requests are bounded and respect limits.
- Quotas: 3 active scans and 25 per day per org.
- The business profile and image library can always be edited manually, and stock images still
  work when a scan fails.

## Steps

1. Look up the failure reason on the scan (`GET /api/studio/scans/<id>`). Typical reasons are an
   HTTP 403 or 429, a challenge page, or a timeout.
2. **Do not** try to evade bot protection. Tell the customer to:
   - Fill in the profile manually, or upload their own images.
   - Add the scanner to their site's allow-list, if they control the site.
3. If failures are rising across many sites, check for egress IP reputation problems. That is a
   DevOps matter.

## Browser-render fallback (BACKLOG 13.37, 14.4)

**Policy.** The browser render is used **only** when the business owner has confirmed they own
or represent the site being scanned. It is **never** used to get round a third party's bot
protection. The scan screen says so next to the confirmation.

- The confirmation is stored per scan: `website_scans.ownershipConfirmedAt` and
  `ownershipConfirmedByUserId` (who ticked "I own this website or am authorised to represent
  it"). A scheduled rescan carries the confirmation of the scan it repeats. Scans made before
  14.4 have no stored confirmation and never use the render; the owner can start a new scan.
  The scan worker passes the renderer only when the confirmation is set (`headlessFor()`).
- When `STUDIO_HEADLESS_RENDER_URL` points at a self-hosted headless Chromium host, a homepage
  refused with HTTP 403, 429 or 503 is rendered once by that browser. The host is the
  open-source Browserless image (`POST /content`).
- The token is sent as `Authorization: Bearer <STUDIO_HEADLESS_RENDER_TOKEN>`, never as
  `?token=` in the URL (URLs end up in access logs). Browserless documents both, and the
  open-source server reads the Bearer header (`getTokenFromRequest`, v2.56.7).
- robots.txt is still read first, and a disallow stops the scan. Only the homepage URL Studio's
  SSRF-guarded fetcher already reached is rendered.
- There is no CAPTCHA solving and no proxy rotation. If the render fails too, the scan fails as
  before; the render error is in the failure details.
- Unset (the default): no render, and the fallback is manual entry plus stock images.
- A successful render sets `website_scans.usedJsRender`.

### Running the headless host (docker-compose.prod.yml, profile `headless-render`)

1. Create the token file on the deploy host (never in the repo; `secrets/` is git-ignored):
   `openssl rand -hex 32 > secrets/browserless-token && chmod 0444 secrets/browserless-token`
   (the container runs as uid 999, so the file must be readable by it), or point
   `BROWSERLESS_TOKEN_FILE` at it.
2. Put the same value in the secret manager as `STUDIO_HEADLESS_RENDER_TOKEN`, and set
   `STUDIO_HEADLESS_RENDER_URL=http://browserless:3000` for the workers.
3. `docker compose -p postmind-studio -f docker-compose.prod.yml --profile headless-render up -d browserless`,
   then redeploy `worker-assets` so it joins the `headless` network and reads the new env.
4. Check: start a scan of a site you own that returns 403 to the scanner; the scan succeeds with
   `usedJsRender = true`. Turn it off by stopping the service and unsetting the URL.

- The image is pinned (`ghcr.io/browserless/chromium:v2.56.7`, `CONCURRENT=2`, `QUEUE_LENGTH=10`,
  `TIMEOUT=45000`); upgrade deliberately. It sits on its own `headless` network with
  `worker-assets` only. DevOps: block its egress to private ranges and the instance metadata
  endpoint (IMDSv2 with hop limit 1), since the browser follows the site's own subresources.

**GAP:** enabling the profile on staging (then production) is an **operator** step.

## Scheduled rescans (BACKLOG 13.10) and ownership disputes (13.11)

- Every business whose newest scan succeeded is rescanned 30 days later (daily sweep at 03:30
  UTC, `sweep-website-rescans` on studio-assets, at most 200 a day). The rescan first sends a
  conditional request for the homepage; a 304, or the same strong ETag or Last-Modified, records
  `website_scans.checkedUnchangedAt` and skips the scan. A business whose newest scan failed is
  not rescanned automatically. `GET /api/studio/businesses/<id>/scans/schedule` shows the next
  rescan. Stock photos refresh weekly (Mondays 04:00 UTC, `sweep-stock-refresh`).
- A rising failure rate right after 03:30 UTC is the rescan sweep: the steps above apply.
- Enterprise customers can prove ownership with a DNS TXT record
  (`_postmind-studio.<domain>` = `pm-studio-verify=<token>`, polled every 10 minutes, expires
  after 7 days). Verification is not required before a scan.
- If a customer says they do not own a scanned site, they (or Customer Success, as them) use
  "I don't own the scanned site" on the Website scan tab (`POST
  /businesses/<id>/domain-verification/dispute`). A purge job deletes the business's scraped
  images at once (the 10-minute poll retries it; the A6.7 deadline is 24 hours). Check
  `domain_verifications.state = 'PURGED'` and `purgeSummary`; audit `studio.domain.purge`.
  Stock and generated images stay, and scheduled rescans stop for that business.
