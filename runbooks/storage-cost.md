# Storage cost balloon (priority risk 8)

| | |
| --- | --- |
| **Metric** | Weekly S3 bill per bucket (`studio-assets`, `studio-renders`, `studio-thumbnails`, `studio-library-assets`). |
| **Threshold** | More than 125% of forecast. The forecast is about 15 TB/year at target scale (spec 17.4). |
| **Escalation** | DevOps, then Finance. |

## Policy (spec 17.4)

- Intermediate assets are deleted after 30 days when there has been no regeneration.
- Rendered videos are kept for the lifetime of the publication plus 90 days.
- CDN caching uses immutable URLs. With `CDN_URL` and a CloudFront key pair configured (13.30),
  objects in `CDN_BUCKET` (default the renders bucket) are served as CloudFront signed URLs with
  the same 24 h expiry as the S3 presigned URLs; rotate the key pair by adding the new public key
  to the distribution's key group, then switching `CLOUDFRONT_KEY_PAIR_ID` /
  `CLOUDFRONT_PRIVATE_KEY`, then removing the old key.

## Steps

1. Break the cost down by bucket and prefix, using S3 Storage Lens or an inventory report. Find
   the bucket that grew.
2. Check that the S3 lifecycle rules are present and match the policy above. They are configured
   in infrastructure, not in this repository.
3. Look for runaway writers:
   - Repeated regenerations.
   - Library ingestion at up to 200 MB per source.
   - Overlay previews.
4. Audit the versioning retention. Old noncurrent versions should expire.

**GAP:** the lifecycle rules live in the infrastructure repo and are **not verified by code
here**. Add the lifecycle policy to the infrastructure-as-code and link it from this runbook.
