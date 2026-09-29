import { defineConfig } from 'prisma/config';

// Phase 19: the Prisma CLI config, moved from package.json#prisma (deprecated; removed in Prisma 7).
// Same behaviour as before: the schema at its default path, migrations next to it, and the seed
// command `prisma db seed` runs. The datasource URL still comes from schema.prisma's
// env("DATABASE_URL"). Checked against the installed prisma@6.19.3 types
// (@prisma/config/dist/index.d.ts: schema, migrations.path, migrations.seed) and
// https://www.prisma.io/docs/orm/reference/prisma-config-reference (read 2026-09-29).
//
// One difference: with a config file, the CLI no longer loads a `.env` file by itself ("Prisma
// config detected, skipping environment variable loading"). Studio never relied on that: the npm
// scripts pass the env file explicitly (`dotenv -e .env.local -- prisma ...`), and CI and the
// deploy containers set DATABASE_URL in the environment.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
