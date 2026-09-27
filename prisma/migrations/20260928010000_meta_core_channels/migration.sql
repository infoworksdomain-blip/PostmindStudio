-- Meta (Instagram / Facebook) channels are registered by PostMind Core through Studio's internal
-- endpoints (Engagement handover 9.5 / 14.13 pattern). Core registers them per organisation and
-- may not know a Studio business, so platform_connections.businessId becomes optional
-- (NULL = available to every business in the organisation).
ALTER TABLE "studio"."platform_connections" ALTER COLUMN "businessId" DROP NOT NULL;
