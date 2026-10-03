import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

// An in-process Postgres (PGlite + pgvector) with every committed migration applied in order,
// the way `prisma migrate deploy` does with DATABASE_URL `?schema=studio` (search_path=studio).

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'prisma', 'migrations');

/** Runs one committed migration (by directory name) against `db`. */
export async function applyMigration(db: PGlite, name: string): Promise<void> {
  await db.exec(readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
}

export async function createMigratedDb(
  options: {
    preinstallVectorIn?: 'public';
    /** Stop before this migration (directory name), to test it against older data. */
    before?: string;
  } = {},
): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { vector } });
  // Simulates the shared cluster where PostMind Core installed pgvector before Studio arrived.
  if (options.preinstallVectorIn) {
    await db.exec(`CREATE EXTENSION vector SCHEMA ${options.preinstallVectorIn};`);
  }
  await db.exec('CREATE SCHEMA IF NOT EXISTS studio; SET search_path TO studio;');
  const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .filter((name) => !options.before || name < options.before);
  for (const name of migrations) await applyMigration(db, name);
  return db;
}
