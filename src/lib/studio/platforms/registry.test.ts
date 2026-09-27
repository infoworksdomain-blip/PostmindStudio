import { describe, expect, it, vi } from 'vitest';
import { PLATFORMS } from '../services/catalog';
import { createPublisherRegistry } from './registry';
import { FacebookReelPublisher, InstagramReelPublisher } from './meta';
import { TikTokPublisher } from './tiktok';
import { XPublisher } from './x';
import { YouTubePublisher } from './youtube';
import { LinkedInPublisher } from './linkedin';

function deps() {
  return { fetchImpl: vi.fn() as unknown as typeof fetch, sleep: vi.fn(), now: vi.fn(() => 0) };
}

describe('createPublisherRegistry', () => {
  it('creates one publisher per catalog platform with the matching platform field', () => {
    const registry = createPublisherRegistry(deps());
    for (const platform of PLATFORMS) {
      expect(registry[platform]).toBeDefined();
      expect(registry[platform].platform).toBe(
        platform === 'instagram_reel' ? 'instagram_reel' : platform,
      );
    }
  });

  it('wires each entry to the expected publisher class', () => {
    const registry = createPublisherRegistry(deps());
    expect(registry.tiktok).toBeInstanceOf(TikTokPublisher);
    expect(registry.youtube_short).toBeInstanceOf(YouTubePublisher);
    expect(registry.youtube).toBeInstanceOf(YouTubePublisher);
    expect(registry.instagram_reel).toBeInstanceOf(InstagramReelPublisher);
    expect(registry.facebook).toBeInstanceOf(FacebookReelPublisher);
    expect(registry.x).toBeInstanceOf(XPublisher);
    expect(registry.linkedin_video).toBeInstanceOf(LinkedInPublisher);
  });

  it('passes an optional graphVersion through to the Meta publishers', () => {
    const registry = createPublisherRegistry({ ...deps(), graphVersion: 'v99.0' });
    expect(registry.instagram_reel).toBeInstanceOf(InstagramReelPublisher);
    expect(registry.facebook).toBeInstanceOf(FacebookReelPublisher);
  });
});
