import { studioDatabaseUrlFromEnv } from '../../src/lib/render/database-url';

// Deployment: Render. Prints the DATABASE_URL Prisma needs (schema=studio, per-service pool size)
// built from RENDER_POSTGRES_URL. Only scripts/render/with-db-url.sh calls this, capturing stdout
// into a variable, so the URL is never written to a log. Errors go to stderr without the URL.

try {
  process.stdout.write(studioDatabaseUrlFromEnv(process.env));
} catch (err) {
  process.stderr.write(`with-db-url: ${err instanceof Error ? err.message : 'failed'}\n`);
  process.exitCode = 1;
}
