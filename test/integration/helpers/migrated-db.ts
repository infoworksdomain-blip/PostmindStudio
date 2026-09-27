import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

// An in-process Postgres (PGlite + pgvector) with every committed migration applied in order,
// the way `prisma migrate deploy` does with DATABASE_URL `?schema=studio` (search_path=studio).

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'prisma', 'migrations');

export async function createMigratedDb(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { vector } });
  await db.exec('CREATE SCHEMA IF NOT EXISTS studio; SET search_path TO studio;');
  const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of migrations) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
  }
  return db;
}
