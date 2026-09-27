import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import { deleteStyleMemory } from '@/lib/studio/services/style-memory';
import { parseStyleMemoryId } from '@/lib/studio/services/style-memory-ids';

// DELETE /api/studio/businesses/:id/style-memory/:memoryId — the user removes an inferred
// memory (spec 10.4: users must be able to correct or remove inferred data about them).
export const DELETE = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const memoryId = parseStyleMemoryId(params.memoryId);
    const { signalType } = await deleteStyleMemory(
      deps.db,
      tenant.organisationId,
      businessId,
      memoryId,
      deps.now(),
    );
    audit(
      'studio.style_memory.delete',
      { type: 'style_memory', id: memoryId },
      {
        businessId,
        signalType,
      },
    );
    return { body: { deleted: true } };
  },
);
