# Deploy on one Hetzner server (Deployment: single VPS) — the primary path

| | |
| --- | --- |
| **What** | PostMind Studio on ONE Hetzner Cloud server in Germany, with Docker Compose: Caddy (HTTPS), web, one worker for every queue, Postgres 17 + pgvector, Valkey, backups to Cloudflare R2. Staging can run on the same server when you need it. |
| **Check** | `https://<domain>/api/health/ready` = 200; `bash scripts/vps/healthcheck.sh production` says OK; the nightly backup timer succeeds. |
| **Who** | The operator (Hetzner and Cloudflare consoles, the server, legal text, Stripe, Resend, Google and Meta apps), DevOps (KMS and R2 keys). The Core team only when `STUDIO_MODE=core` (Core URLs and tokens). |

First launch: follow [go-live.md](go-live.md). It walks through this runbook and the provider
set-ups in order, and generates and checks the env file (`npm run setup:env`, `npm run setup:check`).

Render (`render.yaml`, [render-deploy.md](render-deploy.md)) stays in the repo as an alternative. It
was dropped as the primary path because of its monthly cost.

**Never** paste a secret into a chat, a ticket or this repository. Secrets live only in the server's
env files (`/etc/postmind-studio/*.env`) and in the password manager.

Sources used below, all read on 2026-09-29: Hetzner [server overview](https://docs.hetzner.com/cloud/servers/overview),
[locations](https://docs.hetzner.com/cloud/general/locations/), [creating a server](https://docs.hetzner.com/cloud/servers/getting-started/creating-a-server),
[firewalls](https://docs.hetzner.com/cloud/firewalls/overview), [firewall FAQ](https://docs.hetzner.com/cloud/firewalls/faq),
[backups and snapshots](https://docs.hetzner.com/cloud/servers/backups-snapshots/overview), [server FAQ](https://docs.hetzner.com/cloud/servers/faq)
and the [Cloud API reference](https://docs.hetzner.cloud/) (`change_type`); Docker
[Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/) and [Docker and UFW](https://docs.docker.com/engine/network/packet-filtering-firewalls/);
Caddy [automatic HTTPS](https://caddyserver.com/docs/automatic-https); Cloudflare
[Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/),
[proxy status](https://developers.cloudflare.com/dns/proxy-status/), [Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)
and [IP ranges](https://www.cloudflare.com/ips/); GitHub [Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry);
[pgBackRest user guide](https://pgbackrest.org/user-guide.html); [BullMQ going to production](https://docs.bullmq.io/guide/going-to-production).

## What runs where

```
Internet ─► Cloudflare DNS ─► Hetzner Cloud Firewall (22, 80, 443) ─► UFW ─► Caddy :80/:443 (project postmind-edge)
                                                                            │  studio-edge network
          project postmind-studio (production)                             ▼
          ┌──────────────────────────────────────────────────────────────────────────────┐
          │ web (Next.js :3010) ── worker (all 6 queues, FFmpeg) ── Postgres 17 + pgvector │
          │                          │                     Valkey (DB 3)     │ pgBackRest │
          └──────────────────────────┼─────────────────────────────────────────┼────────────┘
                                     └──► R2 (assets, renders, …)             └──► R2 backup bucket
          project postmind-studio-staging (optional, same layout, own volumes)
```

| File | What it is |
| --- | --- |
| `deploy/vps/compose.yml` | The stack for one environment. Profiles: `migrate`, `ops`, `restore`, `monitoring`, `headless-render`. |
| `deploy/vps/compose.edge.yml`, `deploy/vps/caddy/` | Caddy, shared by both environments; one site file per environment. |
| `deploy/vps/postgres/` | Postgres image (pgvector 0.8.6, PG 17, + pgBackRest) and its settings. |
| `deploy/vps/.env.example`, `backup.env.example` | Every setting, REQUIRED vs OPTIONAL. |
| `deploy/vps/bootstrap.sh` | One-time server hardening + Docker. |
| `scripts/vps/deploy.sh` | Deploy / roll back / stop an environment. |
| `scripts/vps/compose.sh` | `docker compose` for an environment (logs, ps, exec, run). |
| `scripts/vps/backup.sh`, `pg-restore.sh` | Backups and restores. |
| `scripts/vps/healthcheck.sh`, `install-timers.sh` | The 5-minute health check and the nightly backup, as systemd timers. |

## 1. Pick the server

**Default: Hetzner CPX12** — 1 shared AMD vCPU, 2 GB RAM, 40 GB NVMe
([Regular Performance](https://www.hetzner.com/cloud/regular-performance/)), location **Falkenstein
(fsn1)** or **Nuremberg (nbg1)**, with a public IPv4. Check the current price and whether the type
can be ordered on Hetzner's site: on 2026-09-29 the product pages showed many sizes as "currently
unavailable", and the locations page says "Cloud instances may occasionally be unavailable for
ordering". This runbook quotes no prices.

- **x86 only.** The image CI publishes is linux/amd64. Do not pick the ARM `CAX` family: a rescale
  can only change to "a server plan with the same architecture type" (Hetzner server FAQ), so an ARM
  server can never move to x86 in place.
- **What fits in 2 GB.** The default memory limits (`deploy/vps/compose.yml`, checked by
  `test/unit/vps-compose.test.ts` to stay under 1.8 GB) plus a 2 GB swap file:

  | Service | Memory limit | Notes |
  | --- | --- | --- |
  | Postgres | 384 MB | shared_buffers 96 MB, work_mem 4 MB, max_connections 40 |
  | Valkey (Redis) | 128 MB | maxmemory 64 MB, `noeviction` |
  | web | 448 MB | V8 heap capped at 288 MB |
  | worker | 704 MB | all seven queues (incl. studio-email); V8 heap 384 MB; FFmpeg one at a time (`STUDIO_FFMPEG_MAX_CONCURRENT=1`) |
  | Caddy | 96 MB | |
  | **Total** | **1,760 MB** | the OS gets the rest; swap absorbs the migration step during deploys |

- **What does NOT fit in 2 GB** (switch these on only after resizing):
  - Prometheus + Alertmanager + blackbox (about 550 MB of limits): `STUDIO_MONITORING=on` from 4 GB.
  - The browserless headless-render service (1 GB): `HEADLESS_RENDER=on` from 4 GB.
  - Staging running all the time next to production: recommended size **4 GB RAM / 2 vCPU**
    (CPX22). On 2 GB, switch staging on only while you test (section 9).
  - The full 50k corpus ingestion (library jobs buffer up to 200 MB each) and more than one FFmpeg
    at a time.
- **Signs you have outgrown it** (the health check posts the first three):
  - swap more than half used for a long time (`swapon --show`, `free -m`);
  - a container OOM-killed or restarting (`bash scripts/vps/compose.sh production ps`,
    `docker inspect -f '{{.State.OOMKilled}}' <container>`);
  - a queue backlog: more than 500 jobs waiting on a queue (the `StudioQueueBacklog` threshold);
  - `docker stats` shows web or worker at its memory limit, or the CPU at 100 % for minutes while
    renders queue up; API p95 above 300 ms.
- **Resize in place** (Cloud API `change_type`: "Server must be powered off … This copies the
  content of its disk, and starts it again"; "If you plan to downgrade the Server type, set
  `upgrade_disk` to `false`"; Hetzner FAQ: "When scaling up, you can choose to keep your current disk
  size. This allows you to later downgrade to a server plan with the same disk size"):
  1. Stop the stack cleanly: `bash scripts/vps/compose.sh production stop` (workers finish their
     in-flight jobs; stop staging too if it runs). Expect downtime until step 4.
  2. Hetzner Console → the server → **Power → Power off**.
  3. **Rescale** → choose the new type (for example CPX22 or CPX32) and **keep the current disk
     size** (do not upgrade the disk) so you can scale back down later. If you do upgrade the disk,
     the FAQ says the partition must then be grown by hand from the Rescue System, and you can never
     go back to a smaller plan.
  4. **Power on.** Docker starts Caddy again by itself; the containers you stopped in step 1 stay
     stopped (`restart: unless-stopped` keeps an explicit stop), and step 5 starts them.
  5. Raise the limits for the new size in `/etc/postmind-studio/production.env` (the 4 GB values are
     in `deploy/vps/.env.example` comments: `PG_SHARED_BUFFERS=256MB`, `WEB_MEM_LIMIT`,
     `WORKER_MEM_LIMIT`, `WORKER_CPUS=2` on 2 vCPUs, higher `WORKER_CONCURRENCY_*`,
     `STUDIO_FFMPEG_MAX_CONCURRENT=2`) and redeploy the **same** tag:
     `bash scripts/vps/deploy.sh <current tag>`.

## 2. Create the server and its firewall

In the [Hetzner Console](https://console.hetzner.com):

1. **Firewalls → Create Firewall**, name `studio`. Inbound rules (everything else is dropped: "If
   you do not set any rule, all inbound traffic will automatically be blocked"):
   - TCP 22 — ideally only from your own IP address(es);
   - TCP 80 and TCP 443 — any IPv4/IPv6 (Let's Encrypt must reach 80);
   - UDP 443 — any (HTTP/3; optional).
   Leave outbound empty (all allowed). The firewall is enforced on the network, outside the server.
2. **Servers → Add Server**: location Falkenstein or Nuremberg; image **Ubuntu 26.04** (or 24.04); type
   **CPX12**; networking: public IPv4 (and IPv6 if you like); **SSH key: add yours now** — Hetzner:
   "After the server has been created, it is no longer possible to add an SSH key via the Hetzner
   Console"; Firewalls: `studio`; Backups: optional (see section 11); name `postmind-studio-1`.
3. Note the IPv4 address.

## 3. DNS in Cloudflare

In the `postmind.ai` zone (or your domain):

1. **DNS → Records → Add record**: type `A`, name `studio` (staging later: `studio-staging`), IPv4
   = the server. Delete any old `CNAME`/`AAAA` for that name (for example the Render one).
2. **Proxy status — choose one:**
   - **DNS only (grey cloud) — simplest, recommended to start.** Caddy gets and renews the Let's
     Encrypt certificate itself, and sees real client addresses (which the internal-API allow-list
     needs). Cloudflare's SSL mode does not matter for a DNS-only record.
   - **Proxied (orange cloud)** — hides the server's IP and adds Cloudflare's protection. Then:
     1. Do the first deploy while the record is still **DNS only**, so Caddy gets its certificate.
     2. **SSL/TLS → Overview → Full (strict).** Caddy has a publicly trusted certificate for the
        exact host name, which is what Full (strict) requires (otherwise visitors get error 526).
     3. **Always Use HTTPS must not break renewals.** Cloudflare's docs note that it "forces a
        redirect on all requests, including the /.well-known/acme-challenge/* URI path used for
        HTTP-01 domain validation". Turn it off for this host (Caddy already redirects HTTP to
        HTTPS) or use a redirect rule that excludes `/.well-known/acme-challenge/*`.
     4. Put Cloudflare's ranges (https://www.cloudflare.com/ips-v4/ and /ips-v6/, space-separated)
        in `CADDY_TRUSTED_PROXIES` in `production.env`, and redeploy, so Caddy sees the visitor's
        address instead of Cloudflare's.
     5. Switch the record to **Proxied**.
3. **Disconnect the old Cloudflare Workers build** if it still exists: **Workers & Pages →
   postmindstudio → Settings → Builds → Disconnect**
   ([Cloudflare docs](https://developers.cloudflare.com/workers/ci-cd/builds/#disconnecting-builds)).
   Studio is not a Worker.

Check from your laptop: `dig +short studio.postmind.ai` shows the server IP (DNS only) or Cloudflare
addresses (proxied).

## 4. Bootstrap the server (once)

From your laptop, in this repository:

```bash
scp deploy/vps/bootstrap.sh root@<ip>:/root/
ssh root@<ip> 'bash /root/bootstrap.sh'
```

It installs updates, creates the `deploy` user with your SSH key, turns on UFW (22 rate-limited, 80,
443) and fail2ban, enables automatic security updates, installs Docker Engine and the compose plugin
from Docker's own apt repository, adds a 2 GB swap file, sets the timezone to UTC, creates
`/etc/postmind-studio`, `/var/lib/postmind-studio` and `/opt/postmind-studio`, and finally turns off
root and password SSH logins. It is safe to run again. **From now on log in as `deploy`:**

```bash
ssh deploy@<ip>
sudo ufw status verbose       # 22 LIMIT, 80, 443 (tcp + udp)
swapon --show                 # /swapfile 2G
docker compose version
sudo fail2ban-client status sshd
```

Note: ports published by Docker bypass UFW (Docker's docs). The stack therefore publishes only
Caddy's 80/443 and binds everything else to `127.0.0.1`; the Hetzner Cloud Firewall is the filter
that matters.

## 5. Code, image access and env files

On the server, as `deploy`:

1. **The repository** (deploy scripts, compose files, configs — not the app itself, which comes as
   an image):
   ```bash
   git clone https://github.com/infoworksdomain-blip/PostmindStudio.git /opt/postmind-studio
   ```
   If the repository is private, add a read-only **deploy key**: `ssh-keygen -t ed25519 -f
   ~/.ssh/github_deploy -N ''`, paste `~/.ssh/github_deploy.pub` into GitHub → repository →
   **Settings → Deploy keys**, and clone with the `git@github.com:` URL
   (`GIT_SSH_COMMAND='ssh -i ~/.ssh/github_deploy' git clone …`).
2. **The image.** CI pushes `ghcr.io/infoworksdomain-blip/postmind-studio:<commit SHA>` on every
   green `main` build (job `publish-image`, with provenance). "When you first publish a package,
   the default visibility is private" (GitHub docs), so log the server in once, with a personal
   access token **(classic)** that has only `read:packages` ("GitHub Packages only supports
   authentication using a personal access token (classic)"):
   ```bash
   read -rs CR_PAT && echo "$CR_PAT" | docker login ghcr.io -u <github-user> --password-stdin && unset CR_PAT
   ```
   Optional provenance check before a deploy (needs `gh` and a login):
   `gh attestation verify oci://ghcr.io/infoworksdomain-blip/postmind-studio:<sha> --owner infoworksdomain-blip`.
3. **The env files** (section 6):
   ```bash
   cp /opt/postmind-studio/deploy/vps/.env.example /etc/postmind-studio/production.env
   cp /opt/postmind-studio/deploy/vps/backup.env.example /etc/postmind-studio/production.backup.env
   chmod 600 /etc/postmind-studio/*.env
   nano /etc/postmind-studio/production.env   # and the backup file
   ```

## 6. Fill in the env files

Write every secret in **single quotes** (`KEY='value'`): Docker Compose treats single-quoted values
literally and would otherwise expand a `$` inside a secret. Generate the random ones on the server:
`openssl rand -hex 32`. Keep a copy of every secret in the password manager.

`/etc/postmind-studio/production.env` (from `deploy/vps/.env.example`). Phase 18: Studio runs
**standalone by default** (`STUDIO_MODE=standalone`: its own sign-in, Stripe billing and Resend
email). Every `POSTMIND_*` key and `STUDIO_PLATFORM_ORG_IDS` below is needed **only in
`STUDIO_MODE=core`**; `deploy.sh` checks the right set for the mode (`requiredEnvForModes` in
`src/lib/env.ts`).

| Key (standalone, Phase 18) | Required | Where it comes from |
| --- | --- | --- |
| `STUDIO_MODE` | no | Empty or `standalone`; `core` only when Studio runs inside PostMind Core |
| `BETTER_AUTH_SECRET` | yes | `openssl rand -hex 32`; rotation in [auth.md](auth.md) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | yes | Stripe dashboard (runbooks/billing-stripe.md, Track C) |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `STUDIO_EMAIL_FROM`, `STUDIO_UNSUBSCRIBE_SECRET` | yes | Resend dashboard (runbooks/email-resend.md, Track B); the unsubscribe secret is `openssl rand -hex 32` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | Google Cloud OAuth client; unset hides "Continue with Google" |
| `STUDIO_SIGNUPS_ENABLED` | no | `true` (default) opens public sign-up; `false` = invite-only. Production sign-up stays closed while the legal texts still have fill-in markers (below) |
| `STUDIO_IMPERSONATION_ENABLED`, `STUDIO_IMPERSONATION_WRITE` | no | Keep `false` ([auth.md](auth.md) "Impersonation") |
| `STUDIO_SALES_EMAIL`, `STUDIO_SUPPORT_EMAIL`, `STUDIO_LEGAL_ENTITY_NAME` | no, but set them | Shown on the public pages (the footer shows the legal entity name) |

| Key | Required | Where it comes from |
| --- | --- | --- |

| Key | Required | Where it comes from |
| --- | --- | --- |
| `STUDIO_ENV` | yes | `production` (staging file: `staging`) |
| `STUDIO_DOMAIN` | yes | The host name from step 3, e.g. `studio.postmind.ai` |
| `ACME_EMAIL` | yes | An ops mailbox for Let's Encrypt notices (production file only) |
| `POSTGRES_PASSWORD` | yes | `openssl rand -hex 32` (letters and digits only) |
| `METRICS_TOKEN` | yes | `openssl rand -hex 32` |
| `STUDIO_INTERNAL_SERVICE_TOKEN` | yes | `openssl rand -hex 32`. In core mode give it to the Core team (Core sends it on `/api/studio/internal/**`); standalone keeps it private |
| `POSTMIND_CORE_URL`, `POSTMIND_JWKS_URL`, `POSTMIND_JWT_ISSUER`, `POSTMIND_JWT_AUDIENCE`, `POSTMIND_AUDIT_URL` | core mode only | Core team |
| `POSTMIND_SERVICE_TOKEN` | core mode only | Issued by Core to Studio |
| `STUDIO_PLATFORM_ORG_IDS` | core mode only | PostMind staff organisation ids (standalone: staff are users with the `staff` / `superadmin` role and 2FA, [auth.md](auth.md)) |
| `AWS_REGION`, `KMS_KEY_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | yes | DevOps: the KMS key and an IAM user limited to it (`kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey`) |
| `STORAGE_PROVIDER`, `R2_JURISDICTION` | yes | Keep `r2` and `eu` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | yes | Cloudflare dashboard; the app's R2 token ([r2-setup.md](r2-setup.md) step 2) |
| `S3_BUCKET_ASSETS`, `S3_BUCKET_RENDERS`, `S3_BUCKET_THUMBNAILS`, `S3_BUCKET_LIBRARY` | yes | The environment's R2 buckets (staging: `studio1eu`, `eustudio2`, `eustudio3`, `eustudio4`) |
| `S3_BACKUP_BUCKET` | yes | The backup bucket ([r2-setup.md](r2-setup.md) step 7) |
| `STUDIO_USD_TO_GBP_RATE` | yes | Finance (default `0.75`) |
| `STUDIO_FFMPEG_MAX_CONCURRENT`, `WORKER_CONCURRENCY_*`, `STUDIO_LIBRARY_CONCURRENCY` | yes | Keep the example values on 2 GB; raise after a resize |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_DEFAULT_VOICE_ID`, `SHOTSTACK_API_KEY`, `SHOTSTACK_ENVIRONMENT`, `ASSEMBLYAI_API_KEY`, `ASSEMBLYAI_REGION` | yes | Provider dashboards, as in [render-deploy.md](render-deploy.md) step 4 |
| `RUNWAY_API_KEY`, `LUMA_API_KEY`, `GOOGLE_GEMINI_API_KEY` (+ optional `VEO_MODEL`, `VEO_PERSON_GENERATION`) | no | AI clip providers, tried in that order (Runway → Luma → Veo; STANDARD plans try Luma first). Veo: Google AI Studio → Get API key, on a project with billing enabled ([go-live.md](go-live.md) 11.2) |
| `META_APP_ID`, `META_APP_SECRET`, `TIKTOK_*`, `YOUTUBE_*`, `X_*`, `LINKEDIN_*` (client id/secret) | yes | Platform developer portals. The redirect URIs are set by compose from `STUDIO_DOMAIN`: register `https://<domain>/api/studio/platform-connections/oauth-callback?platform=<tiktok\|youtube\|x\|linkedin>` in each portal |
| `STUDIO_FONTS_BASE_URL` | no | Leave empty: Studio serves its render fonts at `https://<domain>/fonts` (`public/fonts/SOURCES.md`). Only for a CDN or a host with extra brand families ([deploy.md](deploy.md)) |
| `STUDIO_IMAGE` | no | Leave empty (GHCR image) |
| `STUDIO_WORKER_QUEUES` | no | Leave empty (all queues) |
| `STUDIO_INTERNAL_ALLOWED_CIDRS` | no | Core's egress IPs as CIDRs, from the Core team. Empty = the internal API is closed at Caddy (Core cannot push Meta tokens) |
| `CADDY_TRUSTED_PROXIES` | no | Cloudflare ranges, only when the record is proxied (step 3) |
| `PG_BACKUPS`, `PG_BACKUP_RETENTION_DAYS` | no | Keep `on` and `22` |
| `STUDIO_MONITORING`, `PROMETHEUS_*`, `ALERTMANAGER_HOST_PORT` | no | `off` on 2 GB (section 10) |
| `OPS_ALERT_WEBHOOK_URL` | no, but set it | A Slack incoming webhook for `#studio-alerts`; the health check and backups post there |
| `HEADLESS_RENDER`, `STUDIO_HEADLESS_RENDER_URL`, `STUDIO_HEADLESS_RENDER_TOKEN` | no | Off on 2 GB ([scan-blocked.md](scan-blocked.md)) |
| Memory and CPU keys (`*_MEM_LIMIT`, `*_CPUS`, `*_NODE_HEAP_MB`, `PG_*`, `*_DB_CONNECTION_LIMIT`, `REDIS_MAXMEMORY`) | no | Empty = the 2 GB defaults |
| `SENTRY_DSN`, `LOG_LEVEL`, other providers, notification webhook | no | As in the repo's `.env.example` |

`/etc/postmind-studio/production.backup.env` (from `deploy/vps/backup.env.example`; only Postgres and
the backup job ever see it):

| Key | Where it comes from |
| --- | --- |
| `S3_BACKUP_ACCESS_KEY_ID`, `S3_BACKUP_SECRET_ACCESS_KEY` | The backup job's R2 token ([r2-setup.md](r2-setup.md) step 7): read on the live buckets, read & write on the backup bucket |
| `PG_BACKUP_CIPHER_PASS` | `openssl rand -hex 32` — **store it in the password manager**: without it no backup can be restored |

Also: add the domain's origin to the assets bucket's CORS rule ([r2-setup.md](r2-setup.md) step 3).

### Legal documents (before public launch)

The public pages `/legal/{terms,privacy,cookies,acceptable-use,dpa,subprocessors}` render
`content/legal/<locale>/<doc>.md` from the image. The repository ships **complete drafts** of all
six English files (`content/legal/en-GB/`, Phase 20.4) with fill-in markers such as
`[[COMPANY LEGAL NAME]]` for your company details. Replace every marker (the list, and where to
find each value, is in `content/legal/FILL-IN.md`), have a solicitor review the texts, and commit
them on the branch you deploy from (translations are optional: `content/legal/fr/terms.md` and so
on; missing ones fall back to English with a note), then rebuild the image. Check with:

```bash
npx tsx scripts/legal/check-ready.ts   # lists MISSING / PLACEHOLDER / FILL-IN (with the markers); exit 1 while terms or privacy block sign-up
```

While terms or privacy still contains a `[[…]]` marker (or is missing, or is an old
`OPERATOR MUST REPLACE` placeholder), **production public sign-up stays closed** and the Admin
Centre shows a warning; the other four only warn, and their pages show a "draft" banner.
`STUDIO_LEGAL_CONTENT_DIR` points the app at another directory if you mount the files instead of
baking them in.

## 7. First deploy

1. Find the image tag: the full commit SHA of a green `main` build (GitHub → Actions → CI → the run
   → `publish-image` succeeded), e.g. `git rev-parse origin/main`.
2. On the server:
   ```bash
   cd /opt/postmind-studio && git pull
   bash scripts/vps/deploy.sh <sha>
   ```
   It checks the env files, pulls the image, builds the Postgres image (first time: a few minutes),
   starts Postgres and Valkey, creates the pgBackRest stanza and runs `pgbackrest check` (proves WAL
   reaches R2), migrates and seeds, starts web then the worker, writes the Caddy site, reloads Caddy,
   waits for `/api/health/ready` inside and then through Caddy (Let's Encrypt certificate included),
   and records the tag. It exits non-zero at the first failure.
3. Install the timers (nightly backup 02:30 UTC, health check every 5 minutes):
   ```bash
   sudo bash scripts/vps/install-timers.sh production
   ```
4. Check:
   ```bash
   curl -s https://studio.postmind.ai/api/health/ready          # 200, database + redis up
   bash scripts/vps/healthcheck.sh production                    # OK
   bash scripts/vps/compose.sh production ps                     # web, worker, postgres, redis healthy
   bash scripts/vps/compose.sh production logs --tail 50 worker  # "studio workers started"
   bash scripts/vps/compose.sh production run --rm migrate npx --no-install prisma migrate status
   bash scripts/vps/backup.sh production db --type full          # first full backup now
   bash scripts/vps/backup.sh production info                    # the backup and the WAL range
   docker stats --no-stream                                      # LIMIT column = the limits above
   ```
   Then a test generation (spends real provider money, about one short clip):
   `bash scripts/vps/compose.sh production run --rm ops node --import tsx scripts/run-test-project.ts --queue`,
   the R2 smoke in [r2-setup.md](r2-setup.md) step 6, and one upload from the browser.
5. Standalone: create the first super-admin (`scripts/auth/create-superadmin.ts --email <addr>`,
   [auth.md](auth.md)), sign in, turn on 2FA, open `/admin` and clear the legal-readiness warning.
   Then open `/` in a private window: the landing page, `/pricing` and `/sign-up` should load.
6. Core mode only: give Core the internal URL (`https://<domain>/api/studio/internal/…`) and
   `STUDIO_INTERNAL_SERVICE_TOKEN`, and put Core's egress IPs in `STUDIO_INTERNAL_ALLOWED_CIDRS`.

## 8. Updates and rollback

- **Update:** after CI is green on `main`: `cd /opt/postmind-studio && git pull && bash scripts/vps/deploy.sh <new sha>`.
  `git pull` updates the deploy files; the app comes from the image. Web restarts for a few seconds;
  Caddy holds requests up to 30 s meanwhile (`lb_try_duration`). The worker finishes in-flight jobs
  (120 s) before it restarts.
  - Release that adds a new job type: `--workers-first` ([deploy.md](deploy.md)).
- **From your laptop:** `bash scripts/vps/deploy.sh --ssh deploy@<ip> <sha>` runs the same thing on
  the server over SSH.
- **Rollback** (decide as in [rollback.md](rollback.md); kill switch first if customers could be harmed):
  ```bash
  bash scripts/vps/deploy.sh --previous          # the tag before the current one
  bash scripts/vps/deploy.sh <older sha>         # any earlier tag
  ```
  The last three deployed images stay on the server, so a rollback does not wait for a download.
  Migrations are expand-only, so the older release runs on the newer schema; never run
  `prisma migrate reset`. The deploy history is in `/var/lib/postmind-studio/production/deployed-tags`.

## 9. Staging on the same server

Staging is a second compose project (`postmind-studio-staging`) with its own Postgres and Valkey
volumes, its own network, its own domain and its own backup path (`postgres/staging/` in the backup
bucket). It costs nothing extra, but **on a 2 GB server run it only while you test** (production +
staging do not fit in 2 GB without heavy swapping). For staging that stays on, resize to 4 GB RAM /
2 vCPU (CPX22, section 1) — or resize just for a test day, keeping the disk size, and back again.

**Switch on:**

1. Cloudflare: an `A` record `studio-staging` → the same IP (step 3).
2. `cp deploy/vps/.env.example /etc/postmind-studio/staging.env` (+ `staging.backup.env`), then
   change what the bottom of `.env.example` lists: `STUDIO_ENV=staging`, the staging domain, new
   `POSTGRES_PASSWORD` / `METRICS_TOKEN` / `STUDIO_INTERNAL_SERVICE_TOKEN`, the staging buckets
   (`studio1eu` …), `SHOTSTACK_ENVIRONMENT=stage`, ports 9190/9193, and the smaller memory values.
3. `bash scripts/vps/deploy.sh --env staging <sha>` and `sudo bash scripts/vps/install-timers.sh staging`.

**Switch off** (containers removed, data volumes kept for next time):

```bash
bash scripts/vps/deploy.sh --env staging --stop
sudo bash scripts/vps/install-timers.sh staging --remove
```

**Staging gate** ([staging-gate.md](staging-gate.md)): `STAGING_DEPLOY_CMD` is
`bash scripts/vps/deploy.sh --env staging --ssh deploy@<ip> {tag}`. For the GitHub workflow, create
an SSH key used only by CI, add its public half to `~deploy/.ssh/authorized_keys`, and add to the
GitHub `staging` environment: secret `VPS_SSH_PRIVATE_KEY`, variable `VPS_SSH_KNOWN_HOSTS` (the
output of `ssh-keyscan <ip>`, compared with the fingerprints `ssh-keygen -lf /etc/ssh/ssh_host_*.pub`
shows on the server), variable `STAGING_DEPLOY_CMD`. The database checks run on the server, because
Postgres is private:

```bash
bash scripts/vps/pg-restore.sh staging snapshot               # 14.7 step 1
bash scripts/vps/compose.sh staging run --rm \
  -e STUDIO_URL=https://studio-staging.postmind.ai -e STUDIO_STAFF_TOKEN -e METRICS_URL -e METRICS_TOKEN \
  --entrypoint sh ops -c 'STAGING_DATABASE_URL="$DATABASE_URL" exec node --import tsx scripts/ops/staging-gate.ts --rehearse kill-switch'
```

## 10. Monitoring

**Default (2 GB): the health check + an external uptime check.**

- `postmind-healthcheck@production.timer` runs `scripts/vps/healthcheck.sh` every 5 minutes:
  readiness through Caddy, container health and OOM kills, swap, memory, disk and queue backlog. It
  posts a problem once (again every 6 h while it lasts) and posts the recovery, to
  `OPS_ALERT_WEBHOOK_URL` (a Slack incoming webhook; payload `{"text": …}`). Logs:
  `journalctl -u postmind-healthcheck@production`.
- It runs **on** the server, so it cannot report the server itself going down. Add an external
  uptime check of `https://<domain>/api/health/ready` from any uptime-monitoring service outside
  Hetzner (several offer a free plan; check their terms), alerting the on-call by email/SMS/Slack.
- Sentry (`SENTRY_DSN`) reports application errors as before, and Studio's own notification webhook
  (`STUDIO_NOTIFY_WEBHOOK_URL`) keeps bridging cost alerts and notifications.

**Full Prometheus stack (from 4 GB):** set `STUDIO_MONITORING=on`, then write the two alert secrets
once and redeploy the current tag:

```bash
printf '%s' '<pagerduty routing key>' > /etc/postmind-studio/secrets/production/pagerduty-routing-key
printf '%s' '<slack webhook url>'     > /etc/postmind-studio/secrets/production/slack-webhook-url
chmod 0444 /etc/postmind-studio/secrets/production/*      # the containers run as nobody
bash scripts/vps/deploy.sh <current sha>
```

Prometheus (v2.55.1), Alertmanager (v0.28.1) and blackbox (v0.28.0) run with the repo's unchanged
alert, SLO and routing files (`deploy/vps/prometheus/prometheus.yml` scrapes `web` and `worker` with
the metrics token). The UIs listen on `127.0.0.1:9090` / `:9093` only: `ssh -L 9090:127.0.0.1:9090
deploy@<ip>` and open http://127.0.0.1:9090/targets. Smoke test:
`bash scripts/vps/compose.sh production run --rm ops node --import tsx scripts/ops/alert-smoke.ts --severity ticket`.
With monitoring on, the health check and backups post to Alertmanager instead (alert
`StudioOpsCheckFailed`, severity ticket → Slack). See [monitoring-deploy.md](monitoring-deploy.md).

## 11. Backups and restore

Details: [backup-recovery.md](backup-recovery.md).

- **Postgres (point-in-time):** pgBackRest archives every WAL segment to
  `s3://<S3_BACKUP_BUCKET>/postgres/<env>/` as it fills or at least every minute (`archive_timeout
  = 60`), encrypted with `PG_BACKUP_CIPHER_PASS`. The nightly timer takes a full backup on Sundays
  and a differential on other days, then runs `pgbackrest check`. Time-based retention of 22 days
  with weekly fulls keeps all backup data within 30 days.
- **Objects:** the same timer runs `scripts/ops/backup-storage.ts --apply` (copies age out 30 days
  after their source was deleted).
- **Failures** are posted like health-check problems; `journalctl -u postmind-backup@production`
  has the output. Run by hand: `bash scripts/vps/backup.sh production [db|storage] [--type full]`.
- **Restore drill** (quarterly, on staging): `pg-restore.sh staging snapshot`, then
  `pg-restore.sh staging drill '<time>'`, then `pg-restore.sh staging check --incident-at <ISO>
  --restore-started-at <ISO>` (the staging gate's `--restore-check` against the restored copy), then
  `pg-restore.sh staging cleanup`.
- **Real incident:** kill switch, then `bash scripts/vps/pg-restore.sh production in-place '<time>' --yes`.
- **Hetzner Backups** (optional, extra cost): daily whole-disk copies in 7 slots
  ([docs](https://docs.hetzner.com/cloud/servers/backups-snapshots/overview)). A second layer against
  losing the server, not a replacement for point-in-time restore; 7 days is inside the 30-day
  limit. Take a manual **snapshot** before risky maintenance (resizes, OS upgrades).

## 12. When to split into two servers

Stay on one server while it is healthy — resize first (section 1). Split when one of these holds:

- Postgres needs more memory than the server can give while FFmpeg renders (cache hit ratio drops,
  p95 climbs during renders), or the database outgrows the local disk;
- render throughput needs more CPU than the largest sensible single server;
- you need the database to survive a server loss with minutes, not a restore, of downtime.

The usual split: keep Postgres + Valkey (+ Caddy + web) on server A, move the worker to server B on
a Hetzner private network. That needs Postgres and Valkey to listen on the private interface (a
compose change, not done yet) and firewall rules for them; or move Postgres to a managed service.
Plan it as a change, not an incident.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `deploy.sh`: `… in /etc/postmind-studio/production.env: …` | A REQUIRED value is missing or malformed; fix the file. |
| `pgbackrest check` fails / hangs | Wrong backup token or bucket, the bucket is not in the EU jurisdiction, or the cipher pass changed. `bash scripts/vps/compose.sh production logs postgres`. While archiving fails, WAL piles up in the Postgres volume: fix it the same day. |
| Not reachable through Caddy | DNS not pointing at the server yet, port 80 blocked (Hetzner firewall), or Cloudflare proxied before the first certificate. `bash scripts/vps/compose.sh edge logs caddy`. |
| Core gets 404 on `/api/studio/internal/…` | `STUDIO_INTERNAL_ALLOWED_CIDRS` is empty or missing Core's address; redeploy after changing it. |
| A container keeps restarting, `OOMKilled=true` | Its memory limit is too low for the load: lower concurrency, or resize (section 1). |
| `range of CPUs is from … to …` when starting | A `*_CPUS` value is higher than the server's vCPU count. |
| `docker pull` denied | The server is not logged in to GHCR, or the token lacks `read:packages` (step 5). |
