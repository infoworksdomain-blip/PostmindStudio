# Deploy (BACKLOG 12.6)

> **Primary path: one Hetzner server** — follow [vps-deploy.md](vps-deploy.md).
> `deploy/vps/compose.yml` runs web, ONE worker for every queue, Postgres 17 + pgvector (with
> pgBackRest point-in-time backups to R2), Valkey and Caddy on a single server;
> `scripts/vps/deploy.sh <sha>` pulls `ghcr.io/infoworksdomain-blip/postmind-studio:<sha>` (pushed
> by CI's `publish-image` job on `main`), migrates, rolls out web then the worker, and waits for
> readiness. Staging is a second compose project on the same server. The environment requirements
> and order of operations below still apply.
>
> **Alternative: Render** — [render-deploy.md](render-deploy.md). Dropped as the primary path for
> cost; `render.yaml` is kept and still validated in CI. The Blueprint replaces
> `docker-compose.prod.yml`: the migration runs as the web service's pre-deploy command, secrets
> live in the `studio-secrets-<env>` environment group, and `DATABASE_URL` is built at start-up by
> `scripts/render/with-db-url.sh`. Render builds each service from the commit rather than pulling a
> registry image, so "the same SHA" means the same commit on staging and production.

## Artifacts

- **Image:** built from `Dockerfile` and tagged with the git SHA. One image serves both roles:
  - Web: `npx next start -p 3010`.
  - Workers: `npx tsx scripts/worker.ts <queue>`.
  The image runs as the `node` user, includes ffmpeg, ffprobe and DejaVu, and uses tini as PID 1.
- **Topology:** `docker-compose.prod.yml` runs web ×3 plus one worker service per queue, sized per
  playbook §7.3: orchestration 3, assets 5, publish 3, scheduled 2, analytics 2, library 1. The
  same layout maps directly onto ECS services or Kubernetes deployments.
- **Single server (primary):** `deploy/vps/compose.yml` — web ×1 and ONE worker process running
  every queue (`STUDIO_WORKER_QUEUES` can split it later), sized for a 2 GB / 1 vCPU server
  ([vps-deploy.md](vps-deploy.md) section 1).
- **CI:** the `docker` job builds the image, checks ffmpeg and the non-root user, probes
  `/api/health`, validates the compose file, and runs the VPS stack smoke (migrate + web readiness
  on the stack's own Postgres and Valkey). `vps-config` runs shellcheck on `scripts/vps/*.sh`,
  `docker compose config` on the VPS files, `caddy validate` and `promtool check config`. On `main`,
  `publish-image` pushes `ghcr.io/infoworksdomain-blip/postmind-studio:<sha>` with BuildKit
  provenance and a GitHub artifact attestation.

## Environment

- Every variable in `.env.example` is documented with where it comes from.
- Secrets live in the secret manager and are rendered to `.env.production` (or task secrets) at
  deploy time. Env files are never baked into the image, because `.dockerignore` excludes them.
- Required in production:
  - Database and queue: `DATABASE_URL` (the `studio` schema), `REDIS_URL` (DB 3).
  - PostMind Core: `POSTMIND_*` (JWKS, issuer, audience, Core URL, service token).
  - Storage: `S3_BUCKET_*`, `AWS_REGION` (S3, the default). With `STORAGE_PROVIDER=r2` also set
    `R2_ACCOUNT_ID`, `R2_JURISDICTION` (optional), `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`,
    and leave `CDN_URL` empty ([r2-setup.md](r2-setup.md)). `AWS_REGION` and the AWS credentials
    are still needed for KMS on both providers.
  - The token-encryption key configuration (see `.env.example`, crypto section).
  - Pricing: `STUDIO_USD_TO_GBP_RATE`.
  - URLs and access: `APP_URL`, `STUDIO_PLATFORM_ORG_IDS`.
  - Monitoring: `METRICS_TOKEN`, `SENTRY_DSN`.
  - The provider and platform keys.
- Browser uploads (13.5, "Upload a video" and slideshow clips) PUT straight to the assets bucket
  with a presigned URL, so `S3_BUCKET_ASSETS` needs a CORS rule allowing `PUT` from the `APP_URL`
  origin with the `Content-Type` header. On both S3 and R2 the URL signs `content-type`
  (`X-Amz-SignedHeaders=content-type;host`), so a PUT with another type gets
  `403 SignatureDoesNotMatch`, and the URL carries no `x-amz-checksum-crc32` /
  `x-amz-sdk-checksum-algorithm` (Phase 17.6: the AWS SDK default put the CRC32 of an *empty* body
  there, which S3 ignores today but would reject every upload with `BadDigest` if it enforced it;
  evidence in `src/lib/studio/storage-client.ts` `PRESIGN_PUT_CHECKSUM_CONFIG`). Only the signing
  client drops the checksum; server-side uploads keep the SDK default. `/complete` still ffprobes
  the file. The web role's IAM policy needs
  `s3:PutObject` there to sign it, plus `s3:GetObject` / `s3:DeleteObject` (probe and reject).
  Without the CORS rule the upload fails in the browser with a network error and the upload stays
  PENDING. Abandoned PENDING uploads are swept by the daily `sweep-abandoned-uploads` job
  (01:45 UTC, studio-orchestration; 14.2 / 17.1): once the presigned PUT URL has been expired for
  `STUDIO_UPLOAD_ABANDON_GRACE_HOURS` (default 24), the object under `orgs/<org>/uploads/<id>/`
  is deleted through the storage layer (S3 or R2) and the `video_uploads` row is marked FAILED
  ("abandoned: the upload was never completed"). READY and FAILED rows are never touched, and
  neither is a PENDING row that a project, video asset / slide or brand kit references: those are
  logged ("abandoned uploads left in place: still referenced") for someone to look at. The worker
  role needs `s3:DeleteObject` on the assets bucket (R2: an Object Read & Write token). A failed
  delete puts the row back to PENDING and the job retries. Do NOT add a blanket S3 expiry on that
  prefix: READY uploads are the footage of UPLOAD projects and slideshow clips.
- Languages (15.C5: en-GB, en-US, fr, es, ar, de, it, pt-BR, pt-PT, hi, zh-Hans) — media side:
  - **Fonts.** Studio serves `NotoSansArabic.ttf`, `NotoSansDevanagari.ttf` and `NotoSansSC.ttf`
    itself from `/fonts` (`public/fonts/`, 20.7; Google Fonts, SIL OFL; the file name is the family
    without spaces). A custom `STUDIO_FONTS_BASE_URL` must serve them too. Overlays, captions and
    cards in Arabic, Hindi and Mandarin are set in these families (Latin languages keep the
    brand/preset font); a missing file fails the render or the overlay pre-render ("Font … could not be downloaded"). `src/lib/studio/overlays/script-fonts.ts`.
  - **Arabic direction.** Shotstack's `rich-text` asset has no direction property; Arabic overlay
    text is prefixed with U+200F (right-to-left mark) and relies on Shotstack's Unicode bidi.
    Verify one Arabic render (a line starting with a Latin brand name) before GA. The FFmpeg
    pre-render (karaoke, glitch, counter) sets `drawtext text_shaping=1` for Arabic, so the
    worker's FFmpeg must be built with `--enable-libfribidi` (and `--enable-libharfbuzz`, which
    drawtext needs anyway and which shapes Devanagari). Check: `ffmpeg -hide_banner -h
    filter=drawtext | grep text_shaping`. Without fribidi Arabic pre-renders fail loudly.
  - **Known limits.** Karaoke splits words on spaces, so Mandarin lines highlight all at once;
    overlay left/right alignment is not mirrored for Arabic.
  - **Voice.** Optional `ELEVENLABS_DEFAULT_VOICE_ID_<LANG>` (e.g. `_AR`, `_HI`, `_ZH_HANS`,
    `_PT_BR`) picks a native-accent default voice per language; unset = the global default (the
    multilingual models speak every Studio language). `language_code` is sent to ElevenLabs only
    for `eleven_flash_v2_5` / `eleven_v3` (not supported by `eleven_multilingual_v2`).
  - **Word timing.** AssemblyAI gets the script's `language_code` (en_uk, en_us, fr, es, ar, de,
    it, pt, hi, zh — all on Universal-3.5 Pro); whisper-1 gets the ISO 639-1 `language`.
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

1. Merge to `main`. CI must be green: `verify`, `database`, `ops-config`, `docker` and `vps-config`.
2. CI's `publish-image` job pushes `ghcr.io/infoworksdomain-blip/postmind-studio:<sha>`.
3. **Staging** (single server: `bash scripts/vps/deploy.sh --env staging <sha>` does steps i–ii and
   waits for readiness; [vps-deploy.md](vps-deploy.md) section 9):
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
4. **Production:** repeat step 3 with the same SHA (`bash scripts/vps/deploy.sh <sha>`). Record
   the SHA and the previous SHA in the deploy log, because [rollback.md](rollback.md) needs the
   previous one. On the single server `deploy.sh` keeps this log itself
   (`/var/lib/postmind-studio/<env>/deployed-tags`) and prints the rollback command.
5. Watch for 30 minutes:
   - Sentry.
   - The p95 API latency.
   - `studio_jobs_total{outcome="failed"}`.
   - Queue depths.

## Order of operations

Migrations always run **before** the new code, and they are expand-only (see
[rollback.md](rollback.md#database-migrations)). Roll out web first, then the workers.

**Exception:** when a release adds a new job type, roll out the workers first. Otherwise jobs
enqueued by the new web code could find no worker that understands them. On the single server:
`bash scripts/vps/deploy.sh --workers-first <sha>`.

## Phase 15 Track B — composition configuration

- **Render fonts (20.7).** Shotstack has no system fonts: every family a render names is fetched
  as `<fonts base>/<FamilyNoSpaces>.ttf`. The fonts base is `STUDIO_FONTS_BASE_URL` when set,
  otherwise `APP_URL/fonts`: Studio ships the files in `public/fonts/` (every overlay preset, the
  onboarding brand fonts, the thumbnail font and `NotoSans`, `NotoSansArabic`, `NotoSansDevanagari`,
  `NotoSansSC`; list, sources and licences in `public/fonts/SOURCES.md`; about 24 MB), and
  `next start` serves them without sign-in (the page guard skips paths with a file extension).
  So leave `STUDIO_FONTS_BASE_URL` empty unless you use a CDN; it must then serve the same files.
  A brand kit that NAMES a family not in `public/fonts/` (free text in the brand kit form) fails
  the render (Shotstack cannot download `<Family>.ttf`): add its TTF to `public/fonts/` (with its
  licence and a SOURCES.md line) or ask the customer to upload the font. Uploaded brand fonts need nothing: their signed S3 URL goes into
  `timeline.fonts`. Shotstack fetches the files from the internet, so `APP_URL` must be the public
  https origin (on the VPS compose sets it from `STUDIO_DOMAIN`).
- `STUDIO_STOCK_VOICES` (optional): `tone=voiceId` pairs for tone-matched stock narration (15.B3).
- `STUDIO_MADE_WITH_CARD_URL` (optional, https): end card for non-white-label organisations
  (operator decision P2). White-label: ENTERPRISE, or `PUT /admin/organisations/:id/policy
  { whiteLabel: true }`.
- The watermark quality check samples frames with FFmpeg (`FFMPEG_PATH`): without FFmpeg, kits
  with a watermark fail that check closed (force-approvable).
