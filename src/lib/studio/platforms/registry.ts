import type { Platform } from '../services/catalog';
import type { PlatformPublisher, PublisherDeps } from './interface';
import { LinkedInPublisher } from './linkedin';
import { FacebookFeedPublisher, FacebookReelPublisher, InstagramReelPublisher } from './meta';
import { TikTokPublisher } from './tiktok';
import { XPublisher } from './x';
import { YouTubePublisher } from './youtube';

export type PublisherRegistry = Record<Platform, PlatformPublisher>;

export function createPublisherRegistry(
  deps: PublisherDeps & { graphVersion?: string },
): PublisherRegistry {
  return {
    tiktok: new TikTokPublisher(deps),
    youtube_short: new YouTubePublisher('youtube_short', deps),
    youtube: new YouTubePublisher('youtube', deps),
    instagram_reel: new InstagramReelPublisher(deps),
    facebook: new FacebookReelPublisher(deps),
    instagram_feed: new InstagramReelPublisher(deps, 'instagram_feed'),
    facebook_feed: new FacebookFeedPublisher(deps),
    x: new XPublisher(deps),
    linkedin_video: new LinkedInPublisher(deps),
  };
}
