import type { EdlShot } from '../pipeline/edl';
import { halfFrameCrop, type Crop } from '../pipeline/edl-stacked';
import { combineCrop, visibleAspect } from '../pipeline/letterbox';
import { AUDIO_MIX_LEVELS, effectiveLayout, type HookDemoDocument } from './hook-demo';

// BACKLOG 22.1 — what composition does differently for a hook + demo script (compose-video.ts):
//   - the hook clip is silent (never the clip's own audio, never narration);
//   - the demo keeps its own audio at the chosen mix, and the music bed ducks under it
//     (AUDIO_MIX_LEVELS; the "music" mix mutes the demo and lets the bed play alone);
//   - stacked layout (portrait outputs only): the hook in the top half over the demo's first
//     seconds in the bottom half, then the demo full frame from where it was (pipeline/edl-stacked);
//   - the on-video AI-generated label is always on when the hook is a generated person.

const RATIO: Record<string, number> = { '9:16': 9 / 16, '16:9': 16 / 9, '1:1': 1, '4:5': 4 / 5 };

export interface HookDemoEdl {
  shots: EdlShot[];
  musicUnderSpeechVolume: number;
  /** The hook is a generated clip (not a library one): the AI label must be shown. */
  aiHook: boolean;
}

export function hookDemoEdl(
  shots: EdlShot[],
  input: {
    doc: HookDemoDocument;
    aspectRatio: string;
    frame: { width: number; height: number };
    /** width ÷ height of the demo upload (probed at upload), when known. */
    demoAspect: number | null;
    /** width ÷ height of the hook clip, when known (default: the output's own ratio). */
    hookAspect: number | null;
    /** The hook's asset came from the reference library, not from a generator. */
    hookFromLibrary: boolean;
  },
): HookDemoEdl {
  const levels = AUDIO_MIX_LEVELS[input.doc.audioMix];
  const [hook, demo, ...rest] = shots;
  const base = { musicUnderSpeechVolume: levels.musicUnder, aiHook: !input.hookFromLibrary };
  if (!hook || !demo) return { ...base, shots };
  const silentHook: EdlShot = {
    ...hook,
    keepSourceAudio: false,
    clipSpeech: false,
    onScreenText: null,
  };
  const demoShot: EdlShot = { ...demo, keepSourceAudio: true, sourceAudioVolume: levels.demo };
  const stacked =
    effectiveLayout(input.doc.layout, input.aspectRatio) === 'stacked' &&
    Boolean(silentHook.visualSrc) &&
    Boolean(demoShot.visualSrc) &&
    silentHook.visualKind !== 'image';
  if (!stacked || !demoShot.visualSrc) return { ...base, shots: [silentHook, demoShot, ...rest] };
  const frameRatio = RATIO[input.aspectRatio] ?? input.frame.width / input.frame.height;
  // 22.6: a half is cut from the picture inside any baked-in bars (pipeline/letterbox.ts).
  const halfCrop = (aspect: number | null, bars: Crop | undefined) =>
    combineCrop(
      bars ?? null,
      halfFrameCrop(visibleAspect(aspect ?? frameRatio, bars ?? null), input.frame),
    );
  return {
    ...base,
    shots: [
      {
        ...silentHook,
        stackedTop: {
          hookCrop: halfCrop(input.hookAspect, silentHook.sourceCrop),
          bottomSrc: demoShot.visualSrc,
          bottomCrop: halfCrop(input.demoAspect, demoShot.sourceCrop),
          bottomVolume: levels.demo,
        },
      },
      // The full-frame demo carries on from where the bottom half stopped.
      { ...demoShot, trimSec: silentHook.durationSec },
      ...rest,
    ],
  };
}
