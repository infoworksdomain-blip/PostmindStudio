import type { PrismaClient } from '@prisma/client';
import { isSuppressed } from '../../email/suppression';
import { studioModes, type StudioModes } from '../../mode';

// Phase 18 §2.8 — whether notification email can reach this user, for the preferences dialog:
//   active         Studio sends email (Resend) and the user's address is not suppressed
//   suppressed     the address hard-bounced or was marked as spam: "we can't email you"
//   pending_setup  no email sender (core mode without a Core email API, or provider "none")

export type EmailDelivery = 'active' | 'suppressed' | 'pending_setup';

export async function emailDeliveryFor(
  deps: { db: Pick<PrismaClient, 'user' | 'emailSuppression'>; modes?: StudioModes },
  userId: string,
): Promise<EmailDelivery> {
  const modes = deps.modes ?? studioModes();
  if (modes.email !== 'resend') return 'pending_setup';
  const user = await deps.db.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (user && (await isSuppressed(deps.db, user.email))) return 'suppressed';
  return 'active';
}
