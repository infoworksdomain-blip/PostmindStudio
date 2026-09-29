import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { AuditAction, type AuditRecord } from '../audit-sink';
import { ValidationError } from '../errors';

// Phase 18 §2.5 — bootstrap platform staff from the CLI (scripts/auth/create-superadmin.ts). No
// password ever comes from env or the command line: a new user gets a set-password link by email
// (Better Auth's reset flow creates the credential account on first use); an existing user is
// promoted. Staff capabilities still need two-factor authentication.

export type StaffRole = 'staff' | 'superadmin';

export interface BootstrapDeps {
  db: Pick<PrismaClient, 'user' | 'session'>;
  /** Sends the set-password email (auth.api.requestPasswordReset). */
  sendSetPasswordLink: (email: string) => Promise<void>;
  audit: (record: AuditRecord) => Promise<void>;
}

export interface BootstrapResult {
  userId: string;
  created: boolean;
  previousRole: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseBootstrapArgs(argv: readonly string[]): { email: string; role: StaffRole } {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const email = value('--email')?.trim().toLowerCase();
  const role = (value('--role') ?? 'superadmin').trim();
  if (!email || !EMAIL.test(email)) {
    throw new ValidationError(
      'Usage: create-superadmin.ts --email <address> [--role staff|superadmin]',
    );
  }
  if (role !== 'staff' && role !== 'superadmin') {
    throw new ValidationError('--role must be staff or superadmin');
  }
  return { email, role };
}

export async function bootstrapStaff(
  deps: BootstrapDeps,
  input: { email: string; role: StaffRole },
): Promise<BootstrapResult> {
  const email = input.email.trim().toLowerCase();
  const existing = await deps.db.user.findUnique({ where: { email } });
  let result: BootstrapResult;
  if (existing) {
    await deps.db.user.update({ where: { id: existing.id }, data: { role: input.role } });
    // End current sessions so the new role (and the 2FA requirement) applies at once.
    await deps.db.session.deleteMany({ where: { userId: existing.id } });
    result = { userId: existing.id, created: false, previousRole: existing.role };
  } else {
    const id = randomBytes(16).toString('hex');
    await deps.db.user.create({
      data: {
        id,
        email,
        name: email.split('@')[0] ?? email,
        // Signing in first needs the emailed set-password link, which proves the inbox.
        emailVerified: true,
        role: input.role,
      },
    });
    result = { userId: id, created: true, previousRole: null };
    await deps.sendSetPasswordLink(email);
  }
  await deps.audit({
    actorType: 'system',
    action: AuditAction.StaffRoleChanged,
    resource: { type: 'user', id: result.userId },
    metadata: { from: result.previousRole, to: input.role, created: result.created, via: 'cli' },
  });
  return result;
}
