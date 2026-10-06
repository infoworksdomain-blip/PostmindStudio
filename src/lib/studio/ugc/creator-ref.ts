import type { ActorImageState } from './portrait';
import { actorDescription, type UgcStyle } from './style';

// BACKLOG 22.3 — what a project that uses a reusable creator stores in metadata.ugc: the style
// (with `creator`: id, pinned portrait id, look text) and actorImage { state: 'creator' } naming
// the same creator and portrait, so the project records which face it uses (portrait.ts reads
// the pinned portrait and never generates one for it).

/** metadata.ugc.actorImage for a project that uses a reusable creator, else null. */
export function creatorActorImage(style: UgcStyle): ActorImageState | null {
  return style.creator
    ? {
        state: 'creator',
        description: actorDescription(style),
        creatorId: style.creator.id,
        portraitId: style.creator.portraitId,
      }
    : null;
}

/** The metadata.ugc object to store for a new (or copied) UGC project. */
export function ugcMetadata(style: UgcStyle): UgcStyle & { actorImage?: ActorImageState } {
  const actorImage = creatorActorImage(style);
  return actorImage ? { ...style, actorImage } : style;
}
