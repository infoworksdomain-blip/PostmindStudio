# syntax=docker/dockerfile:1.7
# PostMind Studio — one image, two roles (BACKLOG 12.6):
#   web     →  next start (API + UI) on :3010
#   worker  →  tsx scripts/worker.ts [queue...]  (BullMQ workers; needs ffmpeg/ffprobe)
# Build:  docker build -t postmind-studio:<git-sha> .
# The same immutable image (tagged by commit SHA) is deployed to staging then production, which is
# what makes rollback a re-deploy of the previous tag (runbooks/rollback.md).

# Node 24 LTS ("Krypton"; Node 20 reached end of life 2026-04-30). Exact patch pinned: Docker Hub
# library/node tag 24.21.0-bookworm-slim, index digest
# sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 (read 2026-09-30).
ARG NODE_VERSION=24.21.0

# ---- deps: install exactly the lockfile (dev deps included: prisma CLI + tsx run in production) ----
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

# ---- build: prisma client + next build ----
FROM deps AS build
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Version-skew protection (next.config.ts deploymentId): CI passes the commit SHA, so a browser tab
# left open across a deploy does a full reload instead of running the old build's code. Empty
# (local builds) leaves it off.
ARG STUDIO_DEPLOYMENT_ID=
ENV STUDIO_DEPLOYMENT_ID=${STUDIO_DEPLOYMENT_ID}
RUN npx prisma generate && npm run build

# ---- runtime ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
# ffmpeg/ffprobe: media probe, overlay pre-render, library previews (worker). DejaVu: the ffmpeg
# drawtext fallback font. tini: PID 1 that forwards SIGTERM so workers finish in-flight jobs.
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends ffmpeg fonts-dejavu-core openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3010
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
# 20.7: public/ (render fonts at /fonts/<Family>.ttf, public/fonts/SOURCES.md; about 24 MB).
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prompts ./prompts
# Phase 18: the operator's legal Markdown for /legal/* (placeholders until replaced).
COPY --from=build --chown=node:node /app/content ./content
# The UI/email message catalogues: the worker renders every email from them at runtime
# (src/lib/i18n/messages.ts imports messages/<locale>.json). Missing here, every email failed on the
# first server with "Cannot find module '/app/messages/en-GB.json'" (2026-09-30).
COPY --from=build --chown=node:node /app/messages ./messages
# The Core internal client, imported by src/lib/studio/ops/core-contract.ts (scripts/core, core mode).
COPY --from=build --chown=node:node /app/integrations ./integrations
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/src ./src
# prisma.config.ts: the seed command for `prisma db seed` (the migrate one-shot) lives there.
COPY --from=build --chown=node:node /app/tsconfig.json /app/next.config.ts /app/prisma.config.ts ./
USER node
EXPOSE 3010 9464
ENTRYPOINT ["/usr/bin/tini", "--"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3010)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "next", "start", "-p", "3010"]
