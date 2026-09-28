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
2. Check that the S3 lifecycle rules are present and match the policy above. They are
   `infra/s3-lifecycle.json` (BACKLOG 14.2); `npx tsx scripts/ops/apply-s3-lifecycle.ts` prints the
   diff between the file and each bucket (dry run; `--apply` writes it).
3. Look for runaway writers:
   - Repeated regenerations.
   - Library ingestion at up to 200 MB per source.
   - Overlay previews.
4. Audit the versioning retention. Old noncurrent versions should expire.

## Lifecycle rules as code (BACKLOG 14.2)

`infra/s3-lifecycle.json`, validated in CI (`src/lib/studio/ops/s3-lifecycle.test.ts`):

| Bucket | Rule | |
| --- | --- | --- |
| assets | `studio-intermediates-expire-30d` | objects tagged `studio-object=provider-output` expire after 30 days |
| all four | `studio-noncurrent-versions-expire-30d` | noncurrent versions after 30 days; expired delete markers removed |
| all four | `studio-abort-incomplete-multipart-7d` | incomplete multipart uploads aborted after 7 days |
| library | `studio-library-staging-expire-2d` | `library/staging/` after 2 days |

- Intermediates are tagged at write time (`storage.ts` `objectTaggingFor`: keys under
  `orgs/<org>/projects/<project>/providers/`), because a lifecycle prefix cannot match
  `orgs/*/projects/*` and `orgs/<org>/` also holds uploads, scraped images and voice consent. The
  writer role needs `s3:PutObjectTagging`. Objects written before the tag existed are never
  expired by the rule.
- Consequence: re-rendering a project more than 30 days after its assets were generated needs a
  regeneration (the shot clips, voice and music have expired).
- No rule expires current objects under `orgs/` by prefix (the validator refuses it): completed
  uploads are UPLOAD projects' footage. Abandoned uploads (still PENDING a day after their upload
  URL expired) are deleted by the daily `sweep-abandoned-uploads` job instead.
- Renders are never expired by lifecycle: "lifetime of the publication + 90 days" is app logic.
- `apply-s3-lifecycle.ts` replaces only `studio-*` rules; other rules on a bucket are read and
  written back unchanged.

**GAP:** applying the rules needs production credentials: **DevOps** runs
`AWS_REGION=… S3_BUCKET_ASSETS=… S3_BUCKET_RENDERS=… S3_BUCKET_THUMBNAILS=… S3_BUCKET_LIBRARY=… npx tsx scripts/ops/apply-s3-lifecycle.ts`,
reviews the diff, then re-runs with `--apply` (needs `s3:GetLifecycleConfiguration` and
`s3:PutLifecycleConfiguration`).
