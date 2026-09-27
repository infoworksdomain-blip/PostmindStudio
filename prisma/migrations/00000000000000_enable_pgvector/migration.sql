-- BACKLOG 0.4: enable pgvector for embedding columns (image library, video library).
-- Runs before any Studio table is created. Idempotent, so it is safe on the shared cluster
-- where PostMind Core may already have installed the extension.
CREATE SCHEMA IF NOT EXISTS "studio";
CREATE EXTENSION IF NOT EXISTS "vector";
