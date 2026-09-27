import { randomUUID } from 'node:crypto';
import { PLATFORMS, type Platform } from '../../src/lib/studio/services/catalog';
import type {
  PlatformPublisher,
  PublishRequest,
  PublishResult,
  TakedownRequest,
} from '../../src/lib/studio/platforms/interface';
import type { PublisherRegistry } from '../../src/lib/studio/platforms/registry';

// Recording publishers for pipeline/API tests. Ids are prefixed "fake_" so they can never be
// mistaken for real platform ids, and carry a random suffix: platform post ids are unique in the
// database, and suites share one database.

export class FakePublisher implements PlatformPublisher {
  readonly published: PublishRequest[] = [];
  readonly takenDown: TakedownRequest[] = [];
  behaviour: (request: PublishRequest) => Promise<PublishResult> | PublishResult;

  constructor(
    readonly platform: Platform,
    readonly supportsTakedown = true,
  ) {
    this.behaviour = () => ({
      platformPostId: `fake_${platform}_${this.published.length}_${randomUUID().slice(0, 8)}`,
      platformUrl: `https://fake.invalid/${platform}/${this.published.length}`,
      metadata: { fake: true },
    });
    if (!supportsTakedown) this.takedown = undefined;
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    this.published.push(request);
    return this.behaviour(request);
  }

  takedown?: (request: TakedownRequest) => Promise<void> = async (request) => {
    this.takenDown.push(request);
  };
}

export function fakePublisherRegistry(): PublisherRegistry & Record<Platform, FakePublisher> {
  return Object.fromEntries(
    PLATFORMS.map((p) => [p, new FakePublisher(p, p !== 'tiktok')]),
  ) as PublisherRegistry & Record<Platform, FakePublisher>;
}
