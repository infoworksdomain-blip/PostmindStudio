# Storage failover to the secondary region (15.E9, spec 4.6)

Spec 4.6: "Storage failures (S3 outage) fall back to a secondary region bucket."

## Setup (DevOps, once)

1. Create one bucket per primary bucket in the fallback region (same encryption, block public
   access, lifecycle rules as the primary). Optionally enable cross-region replication
   primary → fallback so existing objects are readable during an outage.
2. Grant the Studio task role the same S3 permissions on the fallback buckets.
3. Set `S3_FALLBACK_REGION` (must differ from `AWS_REGION`) and the matching
   `S3_FALLBACK_BUCKET_ASSETS / _RENDERS / _THUMBNAILS / _LIBRARY`. A misconfiguration (same
   region, same bucket, no mapped bucket) fails at startup with a configuration error.

## Behaviour

- Writes go to the primary; on a network error, timeout or HTTP 5xx they go to the mapped
  fallback bucket, and the row records the fallback bucket name (`s3Bucket`). 4xx errors
  (AccessDenied, …) never fail over — fix the permission instead.
- Reads of a fallback-recorded object use the fallback region; reads of a primary object try the
  primary, then the same key in the fallback bucket. Signed URLs are signed for wherever the row
  says the object lives (CloudFront only fronts the primary renders bucket).
- Multipart streams (13.15) and server-side copies stay on the primary; the job retries.
- Log line to watch: `primary storage write failed; writing to the fallback region`.

## After an outage

Objects written to the fallback stay there and keep working. To consolidate, copy them back to
the primary and update `s3Bucket` on the rows that name a fallback bucket (video_assets,
video_renders, image_library, video_uploads, data_exports) — a one-off operator script, run with
the service healthy.
