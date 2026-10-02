-- 20.22 overlay kind (expand-only): which overlays mirror the narration. Only narration captions
-- ('caption') are held to the caption_sync quality check; headlines, titles, CTAs and other
-- on-screen text ('on_screen', the default) are expected to differ from what is said.
ALTER TABLE "studio"."text_overlays" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'on_screen';

-- Existing narration captions are the rows recorded in their project's
-- metadata.voiceCaptions[shotId].overlayIds (overlays/voice-captions.ts).
UPDATE "studio"."text_overlays" AS t
SET "kind" = 'caption'
FROM "studio"."video_projects" AS p,
  LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(p."metadata" -> 'voiceCaptions') = 'object'
      THEN p."metadata" -> 'voiceCaptions' ELSE '{}'::jsonb END
  ) AS vc(shot_id, record),
  LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(vc.record -> 'overlayIds') = 'array'
      THEN vc.record -> 'overlayIds' ELSE '[]'::jsonb END
  ) AS caption(id)
WHERE t."id" = caption.id AND t."shotId" = vc.shot_id;
