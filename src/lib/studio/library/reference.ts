import type { PrismaClient, VideoProject, VisualTreatment } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../errors';
import type { PlannedScript } from '../pipeline/scripting';
import {
  applyTemplate,
  assertModeAllowed,
  buildBlueprint,
  inspireSupplement,
  OVERLAY_STYLE_PRESET,
  styleSignature,
  templateConstraint,
  type Blueprint,
} from './blueprint';

// BACKLOG 9.5 — how a LIBRARY_REFERENCE project's reference shapes planning (A3.6 / A3.7).
// The licence is re-checked at planning time: it may have expired since the project was made.

export interface ReferenceGuide {
  mode: 'TEMPLATE' | 'INSPIRE';
  /** Library reference video; null when the structure comes from a project template. */
  referenceVideoId: string | null;
  /** Project template (templates/blueprint.ts loadTemplateGuide), when that is the source. */
  templateId?: string;
  /** Appended to the ideation input (INSPIRE only). */
  ideationSupplement: string | null;
  /** Appended to each Layer 2 prompt. */
  scriptSupplement: (targetSec: number, treatments: VisualTreatment[]) => string;
  /** Enforce the template on the model's script (identity for INSPIRE). */
  apply: (plan: PlannedScript, targetSec: number) => PlannedScript;
  /** Overlay preset key per shot index for suggestions (TEMPLATE only). */
  presetForShot: (index: number) => string | null;
  blueprint: Blueprint | null;
}

export async function loadReferenceGuide(
  db: PrismaClient,
  project: Pick<VideoProject, 'sourceType' | 'referenceVideoId' | 'referenceMode'>,
  now: number,
): Promise<ReferenceGuide | null> {
  if (project.sourceType !== 'LIBRARY_REFERENCE') return null;
  if (!project.referenceVideoId || !project.referenceMode)
    throw new ConflictError('Library-reference project has no reference video or mode');
  const item = await db.videoLibraryItem.findFirst({
    where: { id: project.referenceVideoId, retiredAt: null },
    include: { analysis: true, license: true },
  });
  if (!item?.analysis) throw new NotFoundError('Reference video is not available');
  const mode = project.referenceMode;
  assertModeAllowed(mode, item.license, now);

  if (mode === 'INSPIRE') {
    const supplement = inspireSupplement(styleSignature(item.analysis));
    return {
      mode,
      referenceVideoId: item.id,
      ideationSupplement: supplement,
      scriptSupplement: () => supplement,
      apply: (plan) => plan,
      presetForShot: () => null,
      blueprint: null,
    };
  }
  const blueprint = buildBlueprint(item.analysis);
  return {
    mode,
    referenceVideoId: item.id,
    ideationSupplement: null,
    scriptSupplement: (targetSec, treatments) =>
      templateConstraint(blueprint, targetSec, treatments),
    apply: (plan, targetSec) => applyTemplate(plan, blueprint, targetSec),
    presetForShot: (index) => {
      const style = blueprint.shots[index]?.overlayStyle;
      return style ? OVERLAY_STYLE_PRESET[style] : null;
    },
    blueprint,
  };
}
