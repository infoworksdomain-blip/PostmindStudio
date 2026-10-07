'use client';

import { Player } from '@remotion/player';
import { PostComposition, type PostCompositionProps } from './post-composition';
import { ASPECT_SIZE, PREVIEW_FPS, totalFrames } from './preview-model';
import type { PreviewAspect } from '@/lib/studio/services/post-preview';

// 24.2 — the Remotion Player (https://www.remotion.dev/docs/player/player, read 2026-10-06:
// component + durationInFrames + compositionWidth/Height + fps + inputProps; controls, loop;
// acknowledgeRemotionLicense hides the console notice — the operator approved Remotion under its
// free licence for teams of up to 3, 2026-10-06). Loaded only through post-preview-player.tsx's
// dynamic import, so Remotion never ships with the calendar or any other page bundle.

export interface RemotionPreviewProps {
  aspect: PreviewAspect;
  composition: PostCompositionProps;
  label: string;
}

export default function RemotionPreview({ aspect, composition, label }: RemotionPreviewProps) {
  const size = ASPECT_SIZE[aspect];
  return (
    <div role="region" aria-label={label} className="overflow-hidden rounded-lg bg-black">
      <Player
        component={PostComposition}
        inputProps={composition}
        durationInFrames={totalFrames(composition.media)}
        compositionWidth={size.width}
        compositionHeight={size.height}
        fps={PREVIEW_FPS}
        controls
        loop
        clickToPlay
        initiallyMuted
        showVolumeControls
        acknowledgeRemotionLicense
        style={{ inlineSize: '100%', aspectRatio: `${size.width} / ${size.height}` }}
      />
    </div>
  );
}
