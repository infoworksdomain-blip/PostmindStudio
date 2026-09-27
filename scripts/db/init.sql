-- Runs once, when the local Postgres volume is first created.
CREATE SCHEMA IF NOT EXISTS studio AUTHORIZATION studio;
CREATE EXTENSION IF NOT EXISTS vector;
