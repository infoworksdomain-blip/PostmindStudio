# Publishing platform API breaking change (priority risk 4)

| | |
| --- | --- |
| **Metric** | Daily adapter integration test result per platform, plus `studio_jobs_total{job="publish-video",outcome="failed"}` by platform. |
| **Threshold** | One or more adapter tests failing, or the publish failure rate above 5% for one platform. |
| **Escalation** | Hotfix rota engineer, then the Eng Lead. Product handles customer comms. |

## Steps

1. Confirm which platform is failing, from `publications.errorCode` and the adapter logs
   (`src/lib/studio/platforms/<platform>.ts`). Read the platform changelog.
2. Contain it. Scheduled publications keep retrying with backoff. If the failure is
   non-retryable, tell customers to publish manually. A render can be downloaded with
   `GET /api/studio/renders/<id>/download`.
3. Fix the adapter **from the platform's current documentation**. Never guess new shapes
   (CLAUDE.md rule 2). Add a regression test with the new response shape, then deploy using
   [deploy.md](deploy.md).
4. Retry the failed publications: `POST /api/studio/publications/<id>/retry`.

**Daily canary (13.31):** `.github/workflows/platform-canary.yml` runs every day at 05:30 UTC and
makes one live, read-only call per platform with a sandbox account's token
(`src/lib/studio/platforms/canary.ts`: YouTube `channels?mine=true`, TikTok `creator_info/query`,
X `users/me`, LinkedIn `userinfo`, Instagram `content_publishing_limit`, Facebook video
`?fields=status`). A failure means the token was revoked/expired or the response shape changed:
start at step 1. Secrets (Settings → Secrets → Actions): `CANARY_YOUTUBE_ACCESS_TOKEN`,
`CANARY_TIKTOK_ACCESS_TOKEN`, `CANARY_X_ACCESS_TOKEN`, `CANARY_LINKEDIN_ACCESS_TOKEN`,
`CANARY_INSTAGRAM_ACCESS_TOKEN` + `CANARY_INSTAGRAM_USER_ID`, `CANARY_FACEBOOK_PAGE_TOKEN` +
`CANARY_FACEBOOK_VIDEO_ID`. Platforms without secrets are skipped; with none the run skips with a
notice.

**GAP:** the canary does not post (a daily post to real accounts is an operator decision), and the
sandbox tokens expire: someone must refresh the secrets (TikTok/X/LinkedIn tokens are short-lived).
