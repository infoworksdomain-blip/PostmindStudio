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

**GAP:** a daily scheduled run of the adapter tests against the platforms' sandbox accounts is not
wired into CI yet. It needs sandbox credentials.
