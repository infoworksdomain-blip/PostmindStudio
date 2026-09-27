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

## Browser-render fallback (BACKLOG 13.37)

- When `STUDIO_HEADLESS_RENDER_URL` points at a self-hosted headless Chromium host, a homepage
  refused with HTTP 403, 429 or 503 is rendered once by that browser. The host is the
  open-source Browserless image (`POST /content`).
- robots.txt is still read first, and a disallow stops the scan. Only the homepage URL Studio's
  SSRF-guarded fetcher already reached is rendered.
- There is no CAPTCHA solving and no proxy rotation. If the render fails too, the scan fails as
  before; the render error is in the failure details.
- Unset (the default): no render, and the fallback is manual entry plus stock images.
- A successful render sets `website_scans.usedJsRender`.

**GAP:** the operator must decide whether to run the headless host. It is a policy call against
step 2 above ("do not try to evade bot protection"), and it needs somewhere to run Chromium.

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
