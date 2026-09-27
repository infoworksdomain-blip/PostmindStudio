import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { FLAG_OFF, FLAG_ON, flagKeys, PROVIDER_IDS } from '../system-flags';

// Spec 12 / 16.4 (Admin Centre "Kill switch" + "Workspace freeze"): read and flip the four
// kill-switch levels stored in system_flags. Workers read flags with a 30 s cache, so a change
// takes effect within 30 s everywhere (the admin API's own cache is invalidated immediately).

export const setKillSwitchInput = z
  .object({
    level: z.enum(['global', 'workspace', 'project', 'provider']),
    /** organisationId (workspace), projectId (project) or providerId (provider). */
    target: z.string().trim().min(1).max(128).optional(),
    enabled: z.boolean(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine((v) => v.level === 'global' || Boolean(v.target), {
    message: 'target is required for workspace, project and provider levels',
  })
  .refine(
    (v) => v.level !== 'provider' || (PROVIDER_IDS as readonly string[]).includes(v.target ?? ''),
    {
      message: 'Unknown providerId',
    },
  );

export function flagKeyFor(input: z.infer<typeof setKillSwitchInput>): string {
  switch (input.level) {
    case 'global':
      return flagKeys.global();
    case 'workspace':
      return flagKeys.workspace(input.target ?? '');
    case 'project':
      return flagKeys.project(input.target ?? '');
    case 'provider':
      return flagKeys.provider(input.target ?? '');
  }
}

export async function setKillSwitch(db: PrismaClient, input: z.infer<typeof setKillSwitchInput>) {
  const key = flagKeyFor(input);
  const value = input.enabled ? FLAG_ON : FLAG_OFF;
  return db.systemFlag.upsert({ where: { key }, create: { key, value }, update: { value } });
}

const on = (value: string) => value === FLAG_ON;

export async function killSwitchState(db: PrismaClient) {
  const flags = await db.systemFlag.findMany({ where: { key: { startsWith: 'studio.' } } });
  const pick = (prefix: string) =>
    flags
      .filter((f) => f.key.startsWith(prefix) && on(f.value))
      .map((f) => ({ id: f.key.slice(prefix.length), since: f.updatedAt }));
  const global = flags.find((f) => f.key === flagKeys.global());
  return {
    global: { enabled: global ? on(global.value) : false, since: global?.updatedAt ?? null },
    frozenWorkspaces: pick(flagKeys.workspace('')),
    killedProjects: pick(flagKeys.project('')),
    disabledProviders: pick(flagKeys.provider('')),
    propagationSec: 30,
  };
}
