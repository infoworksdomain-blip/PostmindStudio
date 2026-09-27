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

**GAP:** the Playwright-rendering fallback named in the playbook is not built. Today the fallback
is manual entry plus stock images.
