# Cloudflare R2 setup (Storage: Cloudflare R2)

Studio can store its objects in Cloudflare R2 instead of AWS S3. Set `STORAGE_PROVIDER=r2`. AWS
S3 stays the default (`STORAGE_PROVIDER=s3` or unset), and nothing changes for S3.

What moves to R2, and what does not:

- **Moves to R2:** the four object buckets (assets, renders, thumbnails, library).
- **Stays on AWS:** envelope encryption. `KMS_KEY_ID` and `src/lib/studio/crypto/envelope.ts` keep
  using `AWS_REGION` and the `AWS_*` credentials, so R2 deployments still need those for KMS.
- **Delivery:** plain R2 presigned URLs, at most 7 days. There is no custom domain and no CDN, and
  `CDN_URL` must stay empty on R2. Presigned URLs cannot be used on custom domains.

Cloudflare docs, read 2026-09-28:

- [aws-sdk-js-v3](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)
- [data location](https://developers.cloudflare.com/r2/reference/data-location/)
- [S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [API tokens](https://developers.cloudflare.com/r2/api/tokens/)

## 1. Create four EU-jurisdiction buckets

In the Cloudflare dashboard, go to **R2 object storage → Create bucket** and create each of the four
buckets with the **EU** jurisdiction. The jurisdiction **cannot be changed after creation**, and an
EU bucket is only reachable through `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`.

| Env var | Suggested name | Holds |
| --- | --- | --- |
| `S3_BUCKET_ASSETS` | `studio-assets` | Uploads, provider outputs (`intermediates/`), images, voice consent, exports |
| `S3_BUCKET_RENDERS` | `studio-renders` | Final renders |
| `S3_BUCKET_THUMBNAILS` | `studio-thumbnails` | Render thumbnails |
| `S3_BUCKET_LIBRARY` | `studio-library-assets` | The reference library (`library/`, `library/staging/`) |

- The env var names keep their `S3_` prefix on both providers.
- One client serves one jurisdiction, so all four buckets must share one jurisdiction. So must any
  R2 corpus bucket listed in `STUDIO_CORPUS_S3_BUCKETS`.
- Do **not** add bucket locks to these buckets. A lock blocks deletion, which breaks the organisation
  hard delete (GDPR purge), the abandoned-upload sweep and lifecycle expiry.

## 2. Create the app's API token (Object Read & Write, these buckets only)

1. Go to **R2 → Account Details → API Tokens → Manage**.
2. Create an **Account API token** with the **Object Read & Write** permission.
3. Scope the token to the four buckets. Add the fallback buckets as well, if you use them.
4. Copy the **Access Key ID** and **Secret Access Key** into `R2_ACCESS_KEY_ID` and
   `R2_SECRET_ACCESS_KEY`. The secret is shown once only.

This token can read, write, list and delete objects. It **cannot** change bucket configuration
(CORS, lifecycle). That is deliberate.

For step 4 (lifecycle), create a **second, short-lived token** with **Admin Read & Write**. Managing
lifecycles is a bucket-level action. Use this token only in the shell that applies the lifecycle,
then revoke it.

## 3. CORS for browser uploads

Browsers upload with a presigned PUT straight to the assets bucket (13.5). The PUT URL signs
`content-type`, and the browser sends the returned `content-type` header.

1. Go to **assets bucket → Settings → CORS policy**.
2. Add this rule, using the real `APP_URL` origin:

```json
[
  {
    "AllowedOrigins": ["https://studio.example.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Without this rule the upload fails in the browser with a network error, and the upload stays
PENDING. The pages that play media with `<video src>` or `<img src>` do not need CORS.

## 4. Apply the lifecycle rules

`infra/r2-lifecycle.json` is validated in CI. It contains these rules:

| Bucket | Rule | Effect |
| --- | --- | --- |
| assets | `studio-intermediates-expire-30d` | `intermediates/` expires after 30 days (provider outputs) |
| all four | `studio-abort-incomplete-multipart-7d` | Incomplete multipart uploads are aborted after 7 days |
| library | `studio-library-staging-expire-2d` | `library/staging/` expires after 2 days |

There are no noncurrent-version rules (R2 has no versioning) and no tag filters (R2 has none).

1. Run the dry run with the Admin token from step 2:

   ```bash
   STORAGE_PROVIDER=r2 R2_ACCOUNT_ID=<id> R2_JURISDICTION=eu \
   R2_ACCESS_KEY_ID=<admin key id> R2_SECRET_ACCESS_KEY=<admin secret> \
   S3_BUCKET_ASSETS=... S3_BUCKET_RENDERS=... S3_BUCKET_THUMBNAILS=... S3_BUCKET_LIBRARY=... \
   npx tsx scripts/ops/apply-s3-lifecycle.ts            # dry run: prints the diff
   ```

2. Review the diff. Then run the same command again with `--apply`.

How the script handles existing rules:

- It keeps every rule whose ID does not start with `studio-`. That includes R2's default rule that
  aborts multipart uploads after 7 days, if R2 lists it.
- After writing, it re-reads each bucket and reports any difference.

**Verify on staging first (UNVERIFIED).** The installed AWS SDK always sends an
`x-amz-checksum-crc32` / `x-amz-sdk-checksum-algorithm` header on
`PutBucketLifecycleConfiguration` and `DeleteObjects`. The S3 model requires a checksum on both. R2's
compatibility table lists those checksum headers as not implemented on
`PutBucketLifecycleConfiguration`.

- If `--apply` fails with `501 NotImplemented`, add the three rules by hand. Go to **bucket →
  Settings → Object lifecycle rules → Add rule**, using the same IDs, prefixes and days.
- Then check the result with the dry run.

## 5. Set the environment

| Variable | Value |
| --- | --- |
| `STORAGE_PROVIDER` | `r2` |
| `R2_ACCOUNT_ID` | The Cloudflare account id |
| `R2_JURISDICTION` | `eu`, matching step 1. Empty for buckets created without a jurisdiction (the default, global location): the app, the storage backup job and pgBackRest (`deploy/vps/compose.yml`) then use `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. Production uses this since 2026-09-30 (operator decision: global users); staging stays `eu`. |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | The Object Read & Write token from step 2 |
| `S3_BUCKET_ASSETS` / `_RENDERS` / `_THUMBNAILS` / `_LIBRARY` | The R2 bucket names |
| `CDN_URL` | Empty. CloudFront signing is S3-only, and startup fails otherwise. |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `KMS_KEY_ID` | Unchanged, for KMS |
| `S3_FALLBACK_*` | Optional; see [storage-failover.md](storage-failover.md) |

A missing or invalid R2 variable fails at the first storage use with a `ConfigurationError` that
names every problem.

## 6. Smoke test (staging)

1. Upload a video in the app. The PUT should return 200 and `/complete` should reach READY.
2. Generate one project. Its provider outputs appear under
   `intermediates/orgs/<org>/projects/<project>/providers/` in the assets bucket.
3. Open a render and a thumbnail. These are presigned GETs on
   `<bucket>.<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`.
   - **Check this (UNVERIFIED):** the SDK uses virtual-hosted URLs. Cloudflare documents them for
     the default endpoint only.
   - If the jurisdiction host does not resolve or fails TLS, report it. Path-style addressing
     (`forcePathStyle`) would then be needed.
4. Run a library ingest (multipart upload, then `CopyObject` from `library/staging/`).
5. Run the staging-gate corpus pre-flight. The "Storage provider" line should read
   `Cloudflare R2 via https://<id>.eu.r2.cloudflarestorage.com`.
6. Test an organisation hard delete on a test org. The purge plan lists both `orgs/<id>/` and
   `intermediates/orgs/<id>/` per bucket. This exercises `DeleteObjects`; see the checksum note in
   step 4.

## 7. Backup bucket and backup token (Phase 17.5)

The daily backup job (`studio-backup-storage-<env>`, [backup-recovery.md](backup-recovery.md))
copies the assets, renders and thumbnails buckets into one backup bucket. Per environment:

1. **Create the backup bucket** with the **EU** jurisdiction, like step 1, for example
   `studio-backup` (staging: `studio-backup-staging`). Same account and jurisdiction as the live
   buckets, so the job copies server-side and `S3_BACKUP_REGION` stays `auto`.
   - No bucket lock and no lifecycle expiry of current objects: the job itself deletes copies 30
     days after their source was deleted, and a lock would stop that (purged data must age out).
   - Optional: the step-4 rule `studio-abort-incomplete-multipart-7d` on this bucket too. Nothing
     else.
   - Do **not** add it to the app token from step 2. The app must not be able to read or delete
     the backups.
2. **Create the backup job's token.** It needs **read** on the live buckets and **read & write** on
   the backup bucket. The dashboard applies one permission to all the buckets a token is scoped to,
   so create it with the Cloudflare API, with two policies
   ([API tokens](https://developers.cloudflare.com/r2/api/tokens/), "Workers R2 Storage Bucket Item
   Read" / "... Write" on bucket resources):
   - *Workers R2 Storage Bucket Item Read* on `studio-assets`, `studio-renders`, `studio-thumbnails`;
   - *Workers R2 Storage Bucket Item Write* on `studio-backup`.

   If you can only use the dashboard, create an **Object Read & Write** token scoped to the three
   live buckets **and** the backup bucket. It works, but that token could also delete live objects:
   keep it only in the cron job and rotate it like the app token.
3. Put the values on the cron job (`studio-backup-storage-<env>` → **Environment**; they are
   `sync: false` in `render.yaml`, so Render asks for them when the Blueprint creates the job, and
   otherwise leaves them empty): `S3_BACKUP_BUCKET`, `S3_BACKUP_ACCESS_KEY_ID`,
   `S3_BACKUP_SECRET_ACCESS_KEY`. `S3_BACKUP_REGION=auto` and `S3_BACKUP_RETENTION_DAYS=30` come
   from `render.yaml`.
4. Dry run from the cron job's **Shell**: `npx tsx scripts/ops/backup-storage.ts`. It lists what it
   would copy. Then **Trigger Run** in the dashboard (the job itself runs with `--apply`) and check
   the log ends with `"event":"storage_backup_run"` and `"ok":true`.
   - **Check this (UNVERIFIED):** the first `--apply` run exercises `CopyObject` between two R2
     buckets and `DeleteObjects` (checksum note in step 4) on the backup bucket.

## Key layout on R2 (why `intermediates/`)

On S3, provider outputs (`orgs/<org>/projects/<p>/providers/...`) are tagged
`studio-object=provider-output`, and a tag-filtered lifecycle rule expires them. R2 has no object
tagging and no tag filters.

With `STORAGE_PROVIDER=r2`, `providerOutputKey` therefore writes them under
`intermediates/orgs/<org>/projects/<p>/providers/...`, and a prefix rule expires them. The rest of
the layout stays under `orgs/<org>/`: uploads, images, consent, exports, thumbnails and overlays.

Readers always use the key stored on the row. The organisation hard delete deletes both prefixes on
R2 (`services/purge-storage.ts` `orgPrefixes`).
