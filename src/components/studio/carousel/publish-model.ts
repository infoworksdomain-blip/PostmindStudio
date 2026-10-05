// Where a carousel can be published from the editor (21.6), as a pure model of the account list:
// the server's routes (carousel/publishing.ts CAROUSEL_ROUTES) and limits decide; this only
// groups the business's connected accounts by network and says why a network is unavailable.
import { CAROUSEL_PLATFORM_LIMITS } from '@/lib/studio/carousel/constants';
import { CAROUSEL_ROUTES, carouselComposition } from '@/lib/studio/carousel/publishing';
import type { PlatformConnection, ProjectDetail } from '@/lib/client/types';

export type NetworkId = PlatformConnection['platform'];

/** The Studio destination a carousel uses on each network (null = none). */
export const CAROUSEL_DESTINATION: Readonly<Record<NetworkId, string | null>> = {
  instagram: 'instagram_feed',
  facebook: 'facebook_feed',
  linkedin: 'linkedin_video',
  tiktok: 'tiktok',
  youtube: null,
  x: null,
};

const NETWORK_ORDER: NetworkId[] = ['instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'x'];

export type NetworkStatus =
  | 'ready'
  | 'not_connected'
  | 'too_many_slides'
  | 'too_few_slides'
  | 'youtube_video_only'
  | 'x_not_built';

export interface CarouselNetwork {
  network: NetworkId;
  /** The publications API platform (empty when none). */
  platform: string;
  status: NetworkStatus;
  accounts: PlatformConnection[];
  maxItems?: number;
}

const LIMIT_KEY: Partial<Record<NetworkId, keyof typeof CAROUSEL_PLATFORM_LIMITS>> = {
  instagram: 'instagram',
  facebook: 'facebook',
  linkedin: 'linkedin',
  tiktok: 'tiktok',
};

export function carouselNetworks(
  accounts: readonly PlatformConnection[],
  slideCount: number,
): CarouselNetwork[] {
  return NETWORK_ORDER.map((network) => {
    const destination = CAROUSEL_DESTINATION[network];
    const own = accounts.filter((a) => a.platform === network);
    if (!destination) {
      return {
        network,
        platform: '',
        status: network === 'youtube' ? 'youtube_video_only' : 'x_not_built',
        accounts: [],
      };
    }
    const route = CAROUSEL_ROUTES[destination as keyof typeof CAROUSEL_ROUTES];
    const key = LIMIT_KEY[network];
    const limits = key ? CAROUSEL_PLATFORM_LIMITS[key] : undefined;
    if (!route?.supported || !limits)
      return { network, platform: destination, status: 'x_not_built', accounts: [] };
    if (slideCount > limits.maxItems)
      return {
        network,
        platform: destination,
        status: 'too_many_slides',
        accounts: [],
        maxItems: limits.maxItems,
      };
    if (slideCount < limits.minItems)
      return {
        network,
        platform: destination,
        status: 'too_few_slides',
        accounts: [],
        maxItems: limits.minItems,
      };
    return {
      network,
      platform: destination,
      status: own.length > 0 ? 'ready' : 'not_connected',
      accounts: own,
    };
  });
}

export interface CarouselRenderSummary {
  id: string;
  slideCount: number;
  aiGenerated: boolean;
}

/** The project's latest publishable carousel render (from the project detail's renders). */
export function latestCarouselRender(project: ProjectDetail): CarouselRenderSummary | null {
  const render = project.renders.find(
    (r) =>
      r.targetPlatform === 'carousel' &&
      (r.qualityCheckState === 'PASSED' || r.qualityCheckState === 'FORCE_APPROVED'),
  );
  if (!render) return null;
  const composition = carouselComposition(render.composition);
  return {
    id: render.id,
    slideCount: composition?.slides.length ?? 0,
    aiGenerated: composition?.aiGenerated === true,
  };
}
