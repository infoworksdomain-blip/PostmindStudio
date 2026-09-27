import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

// Local development/test Postgres without Docker: an in-memory PGlite (with pgvector) served
// over the Postgres wire protocol, so Prisma can connect with an ordinary DATABASE_URL.
// Not for production. Usage: npx tsx scripts/dev/pglite-server.ts [port]

async function start(): Promise<void> {
  const port = Number(process.argv[2] ?? 55432);
  const db = await PGlite.create({ extensions: { vector } });
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 10 });
  await server.start();
  process.stdout.write(`pglite listening on 127.0.0.1:${port}\n`);
  const stop = async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void start();
