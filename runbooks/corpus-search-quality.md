# Corpus search quality degradation (priority risk 5)

| | |
| --- | --- |
| **Metric** | Human-graded relevance of the top-5 results on a weekly sample of queries. |
| **Threshold** | Fewer than 80% relevant. |
| **Escalation** | ML Engineer, then Product. |

## Steps

1. Reproduce the problem with the weekly sample queries against `/api/studio/library/videos`
   (search) and `/api/studio/library/videos/<id>/similar`.
2. Check for ingestion drift:
   - Recently ingested videos with missing or poor analysis. Check the admin library view and
     the `studio-library` job failures.
   - A model change in the analysis prompts.
3. Mitigate:
   - Retire the bad items with `POST /api/studio/admin/library/videos/<id>/retire`.
   - Re-ingest a corrected batch.
4. Retraining or re-embedding plan: re-run the analysis for the affected slice through
   `admin/library/ingest`, once the fix is verified on the sample.

## GAP

The 50k-video corpus is not ingested yet (BACKLOG 9.2 and 9.3 are blocked on the licence
register). CLIP/CLAP embeddings and the weekly grading tool don't exist either. This runbook
becomes live when Feature A launches.
