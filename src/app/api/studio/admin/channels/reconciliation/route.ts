import { z } from 'zod';
import { studioModes } from '@/lib/mode';
import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { pendingCoreChannelDirectory } from '@/lib/studio/core/channel-directory';
import {
  CHANNEL_RECONCILIATION_NOT_APPLICABLE,
  channelReconciliationApplies,
} from '@/lib/studio/core/select';
import { reconcileMetaChannels } from '@/lib/studio/services/channel-reconciliation';

// GET /api/studio/admin/channels/reconciliation[?organisationId=] (BACKLOG 13.35, staff only) —
// Studio's Meta channels compared with PostMind Core's list, without applying anything (the
// daily reconcile-channels job applies the fixes). 501 not_implemented "waiting for Core
// list-channels (…)" until Core publishes that endpoint. Phase 18 standalone (Studio's own Meta
// login): 200 { applicable: false, message } — Studio is the source of truth, nothing to compare.
const query = z.object({ organisationId: z.string().trim().min(1).max(128).optional() });

export const GET = withStudioRoute(
  StudioCapability.AdminProviders,
  async ({ req, deps, tenant }) => {
    requirePlatformStaff(tenant);
    const { organisationId } = parseQuery(req, query);
    if (!channelReconciliationApplies(deps.modes ?? studioModes()))
      return { body: { applicable: false, message: CHANNEL_RECONCILIATION_NOT_APPLICABLE } };
    const report = await reconcileMetaChannels(
      {
        db: deps.db,
        directory: deps.core?.channels ?? pendingCoreChannelDirectory,
        logger: deps.logger,
        now: deps.now,
      },
      { apply: false, organisationId },
    );
    return { body: { report } };
  },
);
