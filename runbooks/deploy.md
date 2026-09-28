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
  PENDING. GAP: abandoned PENDING uploads (`orgs/*/uploads/`, rows in `video_uploads`) are not
  swept yet. Do NOT add a blanket S3 expiry on that prefix: READY uploads are the footage of
  UPLOAD projects and slideshow clips.
- Languages (15.C5: en-GB, en-US, fr, es, ar, de, it, pt-BR, pt-PT, hi, zh-Hans) — media side:
  - **Fonts.** `STUDIO_FONTS_BASE_URL` must also serve `NotoSansArabic.ttf`,
    `NotoSansDevanagari.ttf` and `NotoSansSC.ttf` (Google Fonts, SIL OFL; the file name is the
    family without spaces). Overlays, captions and cards in Arabic, Hindi and Mandarin are set in
    these families (Latin languages keep the brand/preset font); a missing file fails the render
    or the overlay pre-render ("Font … could not be downloaded"). `src/lib/studio/overlays/script-fonts.ts`.
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
   3. Run the k6 smoke test (`load-test/k6/studio-api.js`, `RUN_MODE=smoke`) and the golden-path
      smoke.
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

## Phase 15 Track B — composition configuration

- `STUDIO_FONTS_BASE_URL` must host each brand font named in brand kits as `<FamilyNoSpaces>.ttf`
  plus `NotoSans.ttf`, `NotoSansArabic.ttf`, `NotoSansDevanagari.ttf`, `NotoSansSC.ttf`
  (i18n/scripts.ts). Uploaded brand fonts need nothing: their signed S3 URL goes into
  `timeline.fonts`.
- `STUDIO_STOCK_VOICES` (optional): `tone=voiceId` pairs for tone-matched stock narration (15.B3).
- `STUDIO_MADE_WITH_CARD_URL` (optional, https): end card for non-white-label organisations
  (operator decision P2). White-label: ENTERPRISE, or `PUT /admin/organisations/:id/policy
  { whiteLabel: true }`.
- The watermark quality check samples frames with FFmpeg (`FFMPEG_PATH`): without FFmpeg, kits
  with a watermark fail that check closed (force-approvable).
