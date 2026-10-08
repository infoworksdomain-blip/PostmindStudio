// 25.8 — GET /video-models sample handler, shaped like src/app/api/studio/video-models/route.ts
// (providers/video-model-catalogue.ts). The demo has no provider keys, so the list is sample data:
// the five AI-clip providers a fully configured platform registers, with the values the real
// catalogue derives for them (adapter capabilities, typical latency, longest clip, native ratios,
// and a 6 s 9:16 720p clip priced at STUDIO_USD_TO_GBP_RATE 0.75 — video-model-catalogue.test.ts).
// Filtered by the demo organisation's tier like the router's candidate lists; prices only for staff.
import type { VideoModelEntry } from '@/lib/studio/providers/video-model-catalogue';
import { currentTier } from '../billing-state';
import { route } from '../registry';
import { platformRole } from '../viewer-role';

const ALL = ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'] as const;
const PAID = ['STANDARD', 'PLUS', 'ENTERPRISE'] as const;
const BOTH = ['text_to_video', 'image_to_video'] as const;

const SAMPLE: VideoModelEntry[] = [
  {
    providerId: 'seedance',
    displayName: 'Seedance 2.0',
    capabilities: [...BOTH],
    maxClipSec: 30,
    aspectRatios: ['9:16', '16:9', '1:1'],
    audio: false,
    pencePerClip: 69,
    relativeCost: 2,
    typicalLatencySec: 120,
    tiers: [...ALL],
  },
  {
    providerId: 'kling',
    displayName: 'Kling 3.0',
    capabilities: [...BOTH],
    maxClipSec: 15,
    aspectRatios: ['9:16', '16:9', '1:1'],
    audio: false,
    pencePerClip: 38,
    relativeCost: 1,
    typicalLatencySec: 180,
    tiers: [...ALL],
  },
  {
    providerId: 'veo',
    displayName: 'Veo 3.1 Fast',
    capabilities: [...BOTH],
    maxClipSec: 8,
    aspectRatios: ['9:16', '16:9'],
    audio: false,
    pencePerClip: 45,
    relativeCost: 1,
    typicalLatencySec: 120,
    tiers: [...ALL],
  },
  {
    providerId: 'runway',
    displayName: 'Runway Gen-4.5',
    capabilities: [...BOTH],
    maxClipSec: 10,
    aspectRatios: ['9:16', '16:9'],
    audio: false,
    pencePerClip: 54,
    relativeCost: 2,
    typicalLatencySec: 120,
    tiers: [...PAID],
  },
  {
    providerId: 'luma',
    displayName: 'Luma Ray 3.2',
    capabilities: [...BOTH],
    maxClipSec: 10,
    aspectRatios: ['9:16', '16:9', '1:1'],
    audio: false,
    pencePerClip: 68,
    relativeCost: 2,
    typicalLatencySec: 120,
    tiers: [...PAID],
  },
];

const RANK: Record<string, number> = { BASIC: 0, STANDARD: 1, PLUS: 2, ENTERPRISE: 3 };

route('GET', '/video-models', () => {
  const planTier = currentTier();
  const staff = platformRole() !== 'user';
  const models = SAMPLE.filter((m) => m.tiers.includes(planTier)).map((m) => {
    const tiers = m.tiers.filter((t) => (RANK[t] ?? 0) <= (RANK[planTier] ?? 0));
    if (staff) return { ...m, tiers };
    const { pencePerClip: _pence, relativeCost: _relative, ...rest } = m;
    return { ...rest, tiers };
  });
  return { planTier, models };
});
