import { z } from 'zod';
import { auditLogDurable } from '@/lib/audit';
import { deleteAccount } from '@/lib/auth/account-deletion';
import { verifyAccountPassword } from '@/lib/auth/reauth';
import { withSignedInRoute } from '@/lib/auth/session-route';
import { authMailerFromEnv } from '@/lib/email/auth-mailer';
import { ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { getApiDeps } from '@/lib/studio/api/context';
import { purgeOrganisation } from '@/lib/studio/services/organisation-purge';

// Phase 18 §5.11 — POST /api/studio/account/delete {password?}: re-authenticate (the password, or
// a sign-in in the last 15 minutes for Google-only accounts), then delete the account (409
// sole_owner when an organisation with other members would lose its only owner).

const bodySchema = z.object({ password: z.string().max(128).optional() });

export const POST = withSignedInRoute(async ({ req, session }) => {
  let json: unknown;
  try {
    json = JSON.parse((await req.text()) || '{}');
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) throw new ValidationError('Request body failed validation');
  await verifyAccountPassword(prisma, session, parsed.data.password, Date.now());
  const deps = await getApiDeps();
  const billing = deps.billing;
  const mailer = deps.mailer ?? (await authMailerFromEnv(logger));
  const profile = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { locale: true },
  });
  const result = await deleteAccount(
    {
      db: prisma,
      now: Date.now,
      purgeOrganisation: (id) => purgeOrganisation({ db: prisma, now: Date.now }, id),
      ...(billing && { cancelBilling: (id: string) => billing.cancelForDeletion(id) }),
      audit: auditLogDurable,
      notify: async (graceUntil) => {
        await mailer.sendAuthEmail(
          'accountDeletionScheduled',
          session.user.email,
          { name: session.user.name, deleteAt: graceUntil.toISOString() },
          profile?.locale ?? 'en-GB',
          { userId: session.user.id, idempotencyKey: `account-deletion:${session.user.id}` },
        );
      },
    },
    session.user.id,
  );
  return { body: { deleted: true, ...result } };
});
