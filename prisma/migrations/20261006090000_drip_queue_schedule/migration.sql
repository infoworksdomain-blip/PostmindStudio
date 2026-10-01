-- 20.14 posting schedule (expand-only): the high-level schedule a drip queue's weekly slots were
-- resolved from, so the editor reopens in the same mode. Nullable; existing rows keep NULL and
-- their slots, which stay the source of truth for scheduling.
ALTER TABLE "studio"."drip_queues" ADD COLUMN "schedule" JSONB;
