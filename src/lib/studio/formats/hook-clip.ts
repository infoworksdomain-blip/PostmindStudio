import type { Prisma } from '@prisma/client';
import type { HookReaction } from './hook-demo';

// BACKLOG 22.1 — the hook clip of a hook + demo video: a generated person's silent reaction to
// camera (phone-selfie framing), made through the EXISTING actor route (capability actor_video,
// router ACTOR_CANDIDATES: Veo 3.1 Fast first; budgets, cost tracking, kill switch and the provider
// account holds as for any UGC actor clip). It is a silent request (`silent: true`): no spoken line
// in the prompt; Veo's audio is "always on" (docs/veo), so the edit mutes the clip. The prompt is
// built ONLY from the reaction preset — never from owner free text — and always describes a
// fictional adult who does not exist, so the clip can never be a real person. The video carries the
// on-video AI-generated label (compose-video.ts).
//
// The shot is marked in its routing snapshot (`providerRouting.hookClip`), like the clip-budget
// marker (pipeline/clip-budget.ts). One clip is made per aspect ratio: the first script's hook shot
// of that ratio is the leader; the others wait for it and reuse its clip (no second payment).

export const HOOK_CLIP_KEY = 'hookClip';
/** RateDeferredError id while a follower hook shot waits for its leader's clip. */
export const HOOK_CLIP_DEFER_ID = 'hook-clip';
export const HOOK_CLIP_WAIT_MS = 10_000;

export interface HookClipMarker {
  reaction: HookReaction;
  /** The hook shot whose clip this one reuses (absent on the leader). */
  leaderShotId?: string;
}

export function hookClipMarkerOf(
  routing: Prisma.JsonValue | null | undefined,
): HookClipMarker | null {
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) return null;
  const raw = (routing as Record<string, unknown>)[HOOK_CLIP_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  const reaction = marker.reaction;
  if (reaction !== 'surprised' && reaction !== 'curious' && reaction !== 'wait_what') return null;
  return {
    reaction,
    ...(typeof marker.leaderShotId === 'string' && { leaderShotId: marker.leaderShotId }),
  };
}

const REACTION_DIRECTION: Record<HookReaction, string> = {
  surprised:
    'They glance at their phone screen, then look up into the camera with a genuinely surprised, delighted expression: eyebrows up, mouth slightly open, a small lean back.',
  curious:
    'They look into the camera with growing curiosity: head tilts slightly, eyes narrow a little, then widen with interest, as if they just noticed something clever.',
  wait_what:
    'A natural "wait, what?" double take: they look away, then snap back to the camera in disbelief, eyebrows raised, a quick half-smile.',
};

/** The reaction clip's scene prompt (no dialogue: the request is silent). */
export function hookClipPrompt(input: { reaction: HookReaction; actorReference: boolean }): string {
  return [
    input.actorReference
      ? 'The person in the reference image, filmed as a vertical phone selfie at arm’s length.'
      : 'A fictional adult who does not exist (not anyone famous), filmed as a vertical phone selfie at arm’s length, in a bright, casual home setting.',
    REACTION_DIRECTION[input.reaction],
    'Natural, candid, handheld phone-camera look with slight movement; soft daylight.',
    'Keep the face in the lower middle of the frame with clear space above the head for on-screen text.',
    'The person does not speak and there is no dialogue or voice-over; no text, captions, logos, watermarks or products in the frame.',
  ].join(' ');
}
