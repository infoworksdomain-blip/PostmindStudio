import { NotFoundError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import {
  approveReview,
  automationDetail,
  cancelAutomation,
} from '@/lib/studio/services/automation-actions';
import { moreLikeThis } from '@/lib/studio/services/automation-run';
import {
  automationSummary,
  findAutomation,
  kickAutomation,
  pauseAutomation,
  resumeAutomation,
  startAutomation,
} from '@/lib/studio/services/automations';
import { assertMayCancelPublications } from '@/lib/studio/services/content-plan-run';

// POST /api/studio/automations/:id/{start|approve|pause|resume|cancel|more-like-this} (22.5).
//   start           DRAFT → GENERATING: snapshot the content mix, draft the first period
//   approve         REVIEW → ACTIVE: generate and schedule the reviewed period
//   pause / resume  stop / restart new generation and the next period
//   cancel          cancel every post not yet out; the automation ends
//   more-like-this  the weekly insight's format and angle get a (bounded) nudge up
// Starting, approving and resuming approve and publish posts, so they need
// studio:project:approve + studio:publication:write too (content-plan-run.ts).
const ACTIONS = ['start', 'approve', 'pause', 'resume', 'cancel', 'more-like-this'] as const;
type Action = (typeof ACTIONS)[number];

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const action = params.action as Action;
    if (!ACTIONS.includes(action)) throw new NotFoundError('Unknown automation action');
    const id = params.id ?? '';
    const resource = { type: 'automation', id };
    switch (action) {
      case 'start': {
        const { automation, reason } = await startAutomation(deps, tenant, id);
        audit('studio.automation.activate', resource, { stage: 'start', cappedReason: reason });
        await kickAutomation(deps.queue, id, deps.now()).catch(() => undefined);
        return { body: { automation: automationSummary(automation), cappedReason: reason } };
      }
      case 'approve': {
        const automation = await approveReview(deps, tenant, id);
        audit('studio.automation.activate', resource, { stage: 'approve' });
        return { body: { automation: automationSummary(automation) } };
      }
      case 'pause': {
        const automation = await pauseAutomation(deps, tenant.organisationId, id);
        audit('studio.automation.pause', resource, { reason: 'owner' });
        return { body: { automation: automationSummary(automation) } };
      }
      case 'resume': {
        const automation = await resumeAutomation(deps, tenant, id);
        audit('studio.automation.resume', resource);
        return { body: { automation: automationSummary(automation) } };
      }
      case 'cancel': {
        assertMayCancelPublications(tenant);
        const automation = await cancelAutomation(deps, tenant, id);
        audit('studio.automation.cancel', resource);
        return { body: { automation: automationSummary(automation) } };
      }
      case 'more-like-this': {
        const automation = await findAutomation(deps.db, tenant.organisationId, id);
        const nudged = await moreLikeThis(deps.db, tenant, automation);
        audit('studio.automation.more_like_this', resource, nudged ?? undefined);
        return {
          body: { nudged, ...(await automationDetail(deps.db, tenant.organisationId, id)) },
        };
      }
    }
  },
);
