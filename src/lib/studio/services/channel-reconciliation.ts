import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import { NotImplementedError, StudioError } from '../../errors';
import {
  CHANNEL_LIST_PENDING_MESSAGE,
  type CoreChannel,
  type CoreChannelDirectory,
} from '../core/channel-directory';
import { META_CHANNEL_PLATFORMS } from '../platforms/meta-credentials';
import { disconnectMetaChannelById } from './meta-channels';

// BACKLOG 13.35 — Core ↔ Studio Meta channel reconciliation (runbooks/platform-account-
// revocation.md). Core pushes channels to Studio; a missed DELETE leaves a channel active in
// Studio until Meta refuses its token, and a missed register leaves an account unusable. The
// daily job (queue/workers/reconcile-channels.ts) compares each organisation's channels with
// Core's list and applies the safe fixes; GET /api/studio/admin/channels/reconciliation shows the
// same comparison without applying it. Until Core ships list-channels, both are an honest 501.
//
// Findings and what the job does with them:
//   missing_in_core    Studio active / needs_reconnect, Core does not list it → disconnect
//                      (revoke + wipe token, like DELETE /internal/channels). Held instead when it
//                      would disconnect every channel of an organisation with more than one: an
//                      empty Core list is more likely a Core fault than a mass disconnect.
//   missing_in_studio  Core lists it, Studio has no row → reported (Studio has no token; Core
//                      must re-register it with POST /internal/channels).
//   revoked_in_studio  Core lists it, Studio revoked it → reported (only Core can re-register).
//   name_changed       same account, different display name → Studio takes Core's name.

export const RECONCILE_ACTOR = 'system:channel-reconciliation';

export interface StudioChannelRow {
  id: string;
  organisationId: string;
  platform: string;
  platformAccountId: string;
  platformAccountName: string;
  state: string;
}

type ChannelRef = Pick<
  StudioChannelRow,
  'id' | 'platform' | 'platformAccountId' | 'platformAccountName' | 'state'
>;

export type ReconciliationFinding =
  | { kind: 'missing_in_core'; channel: ChannelRef; action: 'disconnect' | 'held' }
  | {
      kind: 'missing_in_studio';
      platform: string;
      platformAccountId: string;
      platformAccountName: string | null;
      action: 'core_must_register';
    }
  | { kind: 'revoked_in_studio'; channel: ChannelRef; action: 'core_must_register' }
  | { kind: 'name_changed'; channel: ChannelRef; coreName: string; action: 'rename' };

export interface OrganisationReconciliation {
  organisationId: string;
  matched: number;
  findings: ReconciliationFinding[];
}

const key = (platform: string, platformAccountId: string) => `${platform}:${platformAccountId}`;
const ref = (c: StudioChannelRow): ChannelRef => ({
  id: c.id,
  platform: c.platform,
  platformAccountId: c.platformAccountId,
  platformAccountName: c.platformAccountName,
  state: c.state,
});

/** Pure comparison of one organisation's Studio rows with Core's list. */
export function reconcileOrganisation(
  organisationId: string,
  studio: StudioChannelRow[],
  core: CoreChannel[],
): OrganisationReconciliation {
  const coreByKey = new Map(core.map((c) => [key(c.platform, c.platformAccountId), c]));
  const studioByKey = new Map(studio.map((c) => [key(c.platform, c.platformAccountId), c]));
  const findings: ReconciliationFinding[] = [];
  let matched = 0;

  const live = studio.filter((c) => c.state !== 'revoked');
  const missing = live.filter((c) => !coreByKey.has(key(c.platform, c.platformAccountId)));
  const hold = missing.length > 1 && missing.length === live.length;
  for (const c of missing) {
    findings.push({
      kind: 'missing_in_core',
      channel: ref(c),
      action: hold ? 'held' : 'disconnect',
    });
  }

  for (const c of core) {
    const row = studioByKey.get(key(c.platform, c.platformAccountId));
    if (!row) {
      findings.push({
        kind: 'missing_in_studio',
        platform: c.platform,
        platformAccountId: c.platformAccountId,
        platformAccountName: c.platformAccountName ?? null,
        action: 'core_must_register',
      });
      continue;
    }
    if (row.state === 'revoked') {
      findings.push({ kind: 'revoked_in_studio', channel: ref(row), action: 'core_must_register' });
      continue;
    }
    matched += 1;
    if (c.platformAccountName && c.platformAccountName !== row.platformAccountName) {
      findings.push({
        kind: 'name_changed',
        channel: ref(row),
        coreName: c.platformAccountName,
        action: 'rename',
      });
    }
  }
  return { organisationId, matched, findings };
}

export interface ReconciliationDeps {
  db: Pick<PrismaClient, 'platformConnection'>;
  directory: CoreChannelDirectory;
  logger: Logger;
  audit?: (entry: AuditEntry) => void;
  now: () => number;
}

export interface ReconciliationReport {
  checkedAt: string;
  applied: boolean;
  organisations: OrganisationReconciliation[];
  errors: Array<{ organisationId: string; error: string; message: string }>;
  totals: { organisations: number; matched: number; findings: number; disconnected: number };
}

async function applyFindings(
  deps: ReconciliationDeps,
  result: OrganisationReconciliation,
): Promise<number> {
  let disconnected = 0;
  for (const f of result.findings) {
    if (f.kind === 'missing_in_core' && f.action === 'disconnect') {
      await disconnectMetaChannelById(deps.db, f.channel.id, result.organisationId);
      disconnected += 1;
      deps.audit?.({
        actorUserId: RECONCILE_ACTOR,
        organisationId: result.organisationId,
        action: 'studio.connection.meta_reconcile_disconnect',
        resource: { type: 'platform_connection', id: f.channel.id },
        metadata: { platform: f.channel.platform, reason: 'not listed by PostMind Core' },
      });
    } else if (f.kind === 'name_changed') {
      await deps.db.platformConnection.updateMany({
        where: { id: f.channel.id, organisationId: result.organisationId },
        data: { platformAccountName: f.coreName },
      });
    } else if (f.kind === 'missing_in_studio' || f.kind === 'revoked_in_studio') {
      deps.logger.warn(
        { organisationId: result.organisationId, kind: f.kind },
        'channel listed by Core but not active in Studio: Core must re-register it',
      );
    } else if (f.kind === 'missing_in_core') {
      deps.logger.warn(
        { organisationId: result.organisationId, channelId: f.channel.id },
        'reconciliation held: Core lists none of the organisation’s channels',
      );
    }
  }
  return disconnected;
}

/**
 * Compare every organisation that has Meta channels in Studio (or just `organisationId`) with
 * Core's list; `apply` makes the fixes above. Throws NotImplementedError until Core ships
 * list-channels. Per-organisation Core failures are reported, not thrown.
 */
export async function reconcileMetaChannels(
  deps: ReconciliationDeps,
  options: { apply: boolean; organisationId?: string },
): Promise<ReconciliationReport> {
  if (!deps.directory.ready) throw new NotImplementedError(CHANNEL_LIST_PENDING_MESSAGE);
  const rows: StudioChannelRow[] = await deps.db.platformConnection.findMany({
    where: {
      platform: { in: [...META_CHANNEL_PLATFORMS] },
      ...(options.organisationId && { organisationId: options.organisationId }),
    },
    select: {
      id: true,
      organisationId: true,
      platform: true,
      platformAccountId: true,
      platformAccountName: true,
      state: true,
    },
    orderBy: [{ organisationId: 'asc' }, { id: 'asc' }],
  });
  const byOrg = new Map<string, StudioChannelRow[]>();
  for (const row of rows)
    byOrg.set(row.organisationId, [...(byOrg.get(row.organisationId) ?? []), row]);
  if (options.organisationId && !byOrg.has(options.organisationId)) {
    byOrg.set(options.organisationId, []);
  }

  const report: ReconciliationReport = {
    checkedAt: new Date(deps.now()).toISOString(),
    applied: options.apply,
    organisations: [],
    errors: [],
    totals: { organisations: 0, matched: 0, findings: 0, disconnected: 0 },
  };
  for (const [organisationId, studio] of byOrg) {
    let core: CoreChannel[];
    try {
      core = await deps.directory.listChannels(organisationId);
    } catch (err) {
      if (err instanceof NotImplementedError) throw err;
      report.errors.push({
        organisationId,
        error: err instanceof StudioError ? err.code : 'internal_error',
        message: err instanceof StudioError ? err.message : 'Core channel list failed',
      });
      deps.logger.error({ err, organisationId }, 'channel reconciliation: Core list failed');
      continue;
    }
    const result = reconcileOrganisation(organisationId, studio, core);
    report.organisations.push(result);
    report.totals.organisations += 1;
    report.totals.matched += result.matched;
    report.totals.findings += result.findings.length;
    if (options.apply) report.totals.disconnected += await applyFindings(deps, result);
  }
  return report;
}
