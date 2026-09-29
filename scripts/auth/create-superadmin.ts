// Phase 18 §2.5 — create or promote platform staff. Run on the server with the app's env:
//   npx tsx scripts/auth/create-superadmin.ts --email ops@example.com [--role staff|superadmin]
// A new user receives a set-password link by email (so a working email sender is needed); an
// existing user is promoted and signed out everywhere. Either way, admin tools stay locked until
// the user turns on two-factor authentication.

import { auditLogDurable } from '../../src/lib/audit';
import { getAuth } from '../../src/lib/auth/server';
import { bootstrapStaff, parseBootstrapArgs } from '../../src/lib/auth/superadmin';
import { logger } from '../../src/lib/logger';
import { prisma } from '../../src/lib/prisma';

async function main(): Promise<void> {
  const input = parseBootstrapArgs(process.argv.slice(2));
  const auth = await getAuth();
  const result = await bootstrapStaff(
    {
      db: prisma,
      audit: auditLogDurable,
      sendSetPasswordLink: async (email) => {
        await auth.api.requestPasswordReset({ body: { email, redirectTo: '/reset-password' } });
      },
    },
    input,
  );
  logger.info(
    { userId: result.userId, created: result.created, role: input.role },
    result.created
      ? 'staff user created and a set-password link emailed; admin tools need 2FA'
      : 'existing user promoted and signed out; admin tools need 2FA',
  );
  await prisma.$disconnect();
}

main().catch(async (err: unknown) => {
  logger.error({ err }, 'create-superadmin failed');
  await prisma.$disconnect();
  process.exit(1);
});
