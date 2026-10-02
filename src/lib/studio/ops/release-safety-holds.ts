import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { ValidationError } from '../../errors';
import {
  isNoProviderSafetyReview,
  releaseNoProviderSafetyReview,
  type ReleaseOptions,
  type ReleaseOutcome,
} from '../services/safety-reviews';

// BACKLOG 20.21 — one-off: release the runs 20.19 parked in QUALITY_CHECKING behind a Trust &
// Safety review only because no content-safety provider was available (Hive's dummy key). Each
// such PENDING content review is closed by the system actor and the run finishes its quality gate
// with content safety "Not scanned" (services/safety-reviews.ts releaseNoProviderSafetyReview).
// Reviews with a real flag are left for staff. The worker does the same on its next quality-gate
// pass; this releases the ones that have no pass coming. CLI: scripts/ops/release-safety-holds.ts.

export const RELEASE_LIMIT_DEFAULT = 500;
export const RELEASE_LIMIT_MAX = 10_000;

export interface ReleaseArgs {
  dryRun: boolean;
  limit: number;
  /** Only this organisation's reviews (--org); all organisations when absent. */
  organisationId?: string;
}

export function parseReleaseArgs(argv: readonly string[]): ReleaseArgs {
  const args: ReleaseArgs = { dryRun: false, limit: RELEASE_LIMIT_DEFAULT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--limit') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 1 || n > RELEASE_LIMIT_MAX)
        throw new ValidationError(`--limit must be a whole number from 1 to ${RELEASE_LIMIT_MAX}`);
      args.limit = n;
      i += 1;
    } else if (arg === '--org') {
      const org = argv[i + 1]?.trim();
      if (!org || org.startsWith('--')) throw new ValidationError('--org needs an organisation id');
      args.organisationId = org;
      i += 1;
    } else throw new ValidationError(`Unknown argument ${arg ?? ''}`);
  }
  return args;
}

export interface ReleaseHoldsDeps extends ReleaseOptions {
  db: PrismaClient;
  logger: Logger;
  audit: Parameters<typeof releaseNoProviderSafetyReview>[0]['audit'];
  now: () => number;
  notifier?: Parameters<typeof releaseNoProviderSafetyReview>[0]['notifier'];
}

export interface ReleaseReport {
  dryRun: boolean;
  /** PENDING content reviews looked at (oldest first, up to the limit). */
  pending: number;
  /** Review ids opened only for want of a provider (released, or to release on a dry run). */
  releasable: string[];
  released: string[];
  /** Reviews with a real flag: left for staff. */
  leftForStaff: number;
  /** Releasable reviews that changed state while the script ran (decided by staff meanwhile). */
  skipped: Array<{ id: string; outcome: Exclude<ReleaseOutcome, 'released'> }>;
}

export async function releaseSafetyHolds(
  deps: ReleaseHoldsDeps,
  args: ReleaseArgs,
): Promise<ReleaseReport> {
  const reviews = await deps.db.safetyReview.findMany({
    where: {
      state: 'PENDING',
      kind: 'content',
      ...(args.organisationId && { organisationId: args.organisationId }),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: args.limit,
  });
  const releasable = reviews.filter(isNoProviderSafetyReview).map((r) => r.id);
  const report: ReleaseReport = {
    dryRun: args.dryRun,
    pending: reviews.length,
    releasable,
    released: [],
    leftForStaff: reviews.length - releasable.length,
    skipped: [],
  };
  if (args.dryRun) return report;
  for (const id of releasable) {
    const outcome = await releaseNoProviderSafetyReview(deps, id, { afterReady: deps.afterReady });
    if (outcome === 'released') report.released.push(id);
    else report.skipped.push({ id, outcome });
  }
  return report;
}
