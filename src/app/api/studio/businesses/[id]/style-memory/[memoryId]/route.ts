import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import {
  deleteStyleMemory,
  updateStyleMemory,
  updateStyleMemoryInput,
} from '@/lib/studio/services/style-memory';
import { parseStyleMemoryId } from '@/lib/studio/services/style-memory-ids';

// PATCH /api/studio/businesses/:id/style-memory/:memoryId { value?, pinned?, disabled? } —
// 15.E6, spec 10.4 "Users can view and edit their style memory". Editing the value pins the memory
// (the nightly build never overwrites a pinned one) unless pinned: false is sent; disabled keeps it
// but stops it guiding scripts. → 200 { memory }
export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const memoryId = parseStyleMemoryId(params.memoryId);
    const input = await parseBody(req, updateStyleMemoryInput);
    const memory = await updateStyleMemory(
      deps.db,
      tenant.organisationId,
      businessId,
      memoryId,
      input,
      deps.now(),
    );
    audit(
      'studio.style_memory.update',
      { type: 'style_memory', id: memoryId },
      {
        businessId,
        signalType: memory.signalType,
        valueEdited: input.value !== undefined,
        pinned: memory.pinned,
        disabled: memory.disabled,
      },
    );
    return { body: { memory } };
  },
);

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
