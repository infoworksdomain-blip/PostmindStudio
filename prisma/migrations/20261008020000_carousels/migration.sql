-- 21.6 carousels (expand-only): a post-card image carousel project, stored in
-- video_projects.metadata.carousel and rendered to one video_renders row (targetPlatform
-- 'carousel') whose composition lists the slide images. Month plans may hold carousel items.
ALTER TYPE "studio"."VideoSourceType" ADD VALUE IF NOT EXISTS 'CAROUSEL';
ALTER TYPE "studio"."ContentPlanItemKind" ADD VALUE IF NOT EXISTS 'CAROUSEL';
