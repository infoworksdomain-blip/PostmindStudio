import { PrismaClient, type Prisma } from '@prisma/client';

// Integration point 1 (Engagement handover Section 7.2): singleton PrismaClient for the
// `studio` schema. Reused across hot reloads in development so connections don't leak.

export function prismaLogLevels(nodeEnv: string | undefined): Prisma.LogLevel[] {
  return nodeEnv === 'development' ? ['query', 'error', 'warn'] : ['error'];
}

const globalForPrisma = globalThis as unknown as { studioPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.studioPrisma ?? new PrismaClient({ log: prismaLogLevels(process.env.NODE_ENV) });

if (process.env.NODE_ENV !== 'production') globalForPrisma.studioPrisma = prisma;
