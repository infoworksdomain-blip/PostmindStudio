-- 21.4 UGC actor videos (expand-only, safe for the running version: runbooks/rollback.md). A shot
-- whose picture is a generated actor speaking its line to camera; the clip's own audio is the
-- narration. The new value is not used inside this migration, so ADD VALUE may run in the
-- migration's transaction.
ALTER TYPE "studio"."VisualTreatment" ADD VALUE 'UGC_ACTOR';
