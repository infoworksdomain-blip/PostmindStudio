# Deploy (BACKLOG 12.6)

## Artifacts

- **Image:** built from `Dockerfile` and tagged with the git SHA. One image serves both roles:
  - Web: `npx next start -p 3010`.
  - Workers: `npx tsx scripts/worker.ts <queue>`.
  The image runs as the `node` user, includes ffmpeg, ffprobe and DejaVu, and uses tini as PID 1.
- **Topology:** `docker-compose.prod.yml` runs web ×3 plus one worker service per queue, sized per
  playbook §7.3: orchestration 3, assets 5, publish 3, scheduled 2, analytics 2, library 1. The
  same layout maps directly onto ECS services or Kubernetes deployments.
- **CI:** the `docker` job builds the image, checks ffmpeg and the non-root user, probes
  `/api/health`, and validates the compose file.

## Environment

- Every variable in `.env.example` is documented with where it comes from.
- Secrets live in the secret manager and are rendered to `.env.production` (or task secrets) at
  deploy time. Env files are never baked into the image, because `.dockerignore` excludes them.
- Required in production:
  - Database and queue: `DATABASE_URL` (the `studio` schema), `REDIS_URL` (DB 3).
  - PostMind Core: `POSTMIND_*` (JWKS, issuer, audience, Core URL, service token).
  - Storage: `S3_BUCKET_*`, `AWS_REGION`.
  - The token-encryption key configuration (see `.env.example`, crypto section).
  - Pricing: `STUDIO_USD_TO_GBP_RATE`.
  - URLs and access: `APP_URL`, `STUDIO_PLATFORM_ORG_IDS`.
  - Monitoring: `METRICS_TOKEN`, `SENTRY_DSN`.
  - The provider and platform keys.
- Browser uploads (13.5, "Upload a video" and slideshow clips) PUT straight to the assets bucket
  with a presigned URL, so `S3_BUCKET_ASSETS` needs a CORS rule allowing `PUT` from the `APP_URL`
  origin with the `Content-Type` header (the URL signs it). The web role's IAM policy needs
  `s3:PutObject` there to sign it, plus `s3:GetObject` / `s3:DeleteObject` (probe and reject).
  Without the CORS rule the upload fails in the browser with a network error and the upload stays
  PENDING. Abandoned PENDING uploads (`orgs/*/uploads/`, rows in `video_uploads`) are deleted by
  the daily `sweep-abandoned-uploads` job (BACKLOG 14.2) a day after their upload URL expired.
  Do NOT add a blanket S3 expiry on that prefix: READY uploads are the footage of UPLOAD projects
  and slideshow clips (the lifecycle validator refuses such a rule).
- BACKLOG 14.1 / 14.2: the worker role also needs `s3:PutObjectTagging` on the assets and renders
  buckets (provider outputs are tagged for the intermediates lifecycle rule) and
  `s3:ListBucket` + `s3:DeleteObject` on every Studio bucket (organisation hard delete).
- **`STUDIO_DEV_TENANT` must never be set outside local development.** It is ignored unless
  `NODE_ENV=development`, and the image sets `NODE_ENV=production`.

## Release steps

1. Merge to `main`. CI must be green: `verify`, `database`, and `docker`.
2. Build and push `postmind-studio:<sha>`.
3. **Staging:**
   1. Run the migrations:
      ```bash
      IMAGE_TAG=<sha> docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate
      ```
      This runs `prisma migrate deploy` and the idempotent seed.
   2. Roll out web, then the workers.
   3. Run the k6 smoke test and the golden-path smoke. The k6 smoke is
      `npx tsx scripts/ops/staging-gate.ts --k6 smoke` (`BASE_URL`, `STUDIO_TOKEN`). It runs
      `load-test/k6/studio-api.js`, re-checks the spec 17.1 thresholds and writes
      `ops/results/<date>-k6-smoke.md`. Before launch, work through the full GATE 12 checklist in
      [staging-gate.md](staging-gate.md).
4. **Production:** repeat step 3 with the same SHA. Record the SHA and the previous SHA in the
   deploy log, because [rollback.md](rollback.md) needs the previous one.
5. Watch for 30 minutes:
   - Sentry.
   - The p95 API latency.
   - `studio_jobs_total{outcome="failed"}`.
   - Queue depths.

## Order of operations

Migrations always run **before** the new code, and they are expand-only (see
[rollback.md](rollback.md#database-migrations)). Roll out web first, then the workers.

**Exception:** when a release adds a new job type, roll out the workers first. Otherwise jobs
enqueued by the new web code could find no worker that understands them.
