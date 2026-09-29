# syntax=docker/dockerfile:1.7
# PostMind Studio — Postgres for the single-server deployment (deploy/vps/compose.yml).
#
# Base: the pgvector image CI migrates against (.github/workflows/ci.yml database job). Its tag
# 0.8.6-pg17 is the bookworm build: pgvector's Dockerfile is FROM postgres:$PG_MAJOR-bookworm
# (github.com/pgvector/pgvector Dockerfile, Docker Hub digests of 0.8.6-pg17 and
# 0.8.6-pg17-bookworm are identical; read 2026-09-29).
#
# pgBackRest: WAL archiving + base backups to the R2 backup bucket (runbooks/backup-recovery.md).
# It is packaged in the PostgreSQL apt repository ("Debian/Ubuntu packages for pgBackRest are
# available at apt.postgresql.org", https://pgbackrest.org/user-guide.html), which the official
# postgres:17-bookworm image already configures (/etc/apt/sources.list.d/pgdg.list,
# github.com/docker-library/postgres 17/bookworm/Dockerfile; read 2026-09-29). It must live in the
# Postgres container because archive_command runs there.
#
# Built on the server by `docker compose build` (scripts/vps/deploy.sh); CI builds it too.
FROM pgvector/pgvector:0.8.6-pg17-bookworm

RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends pgbackrest ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -o postgres -g postgres -m 0750 /var/log/pgbackrest /var/spool/pgbackrest /tmp/pgbackrest \
  && pgbackrest version
