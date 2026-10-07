import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryProjectEventBus,
  liveChannel,
  parseProjectChange,
  type ProjectChange,
} from './events';
import { createRedisProjectEventBus, type PubSubClient } from './redis-bus';

const logger = pino({ level: 'silent' });

/** An in-memory stand-in for two ioredis connections sharing one server. */
function fakeRedis() {
  const subscribers = new Set<FakeClient>();
  class FakeClient implements PubSubClient {
    channels = new Set<string>();
    private handler: ((channel: string, message: string) => void) | undefined;
    failPublish = false;
    async publish(channel: string, message: string) {
      if (this.failPublish) throw new Error('redis down');
      let n = 0;
      for (const s of subscribers)
        if (s.channels.has(channel)) {
          n += 1;
          s.handler?.(channel, message);
        }
      return n;
    }
    async subscribe(channel: string) {
      this.channels.add(channel);
      subscribers.add(this);
    }
    async unsubscribe(channel: string) {
      this.channels.delete(channel);
    }
    on(_event: 'message', listener: (channel: string, message: string) => void) {
      this.handler = listener;
      return this;
    }
    disconnect = vi.fn();
  }
  const clients: FakeClient[] = [];
  return {
    clients,
    connect: () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    },
  };
}

describe('project change messages', () => {
  it('names one channel per organisation under the prefix', () => {
    expect(liveChannel('studio', 'org_1')).toBe('studio:live:org:org_1');
  });

  it('accepts only { projectId } and drops anything else', () => {
    expect(parseProjectChange('{"projectId":"p1","extra":"x"}')).toEqual({ projectId: 'p1' });
    expect(parseProjectChange('{"projectId":""}')).toBeNull();
    expect(parseProjectChange('not json')).toBeNull();
    expect(parseProjectChange('{"projectId":7}')).toBeNull();
  });
});

describe('memory bus', () => {
  it("delivers only to the organisation's listeners and stops after unsubscribe", async () => {
    const bus = createMemoryProjectEventBus();
    const a: ProjectChange[] = [];
    const b: ProjectChange[] = [];
    const stopA = await bus.subscribe('org_a', (c) => a.push(c));
    await bus.subscribe('org_b', (c) => b.push(c));
    await bus.publish('org_a', { projectId: 'p1' });
    expect(a).toEqual([{ projectId: 'p1' }]);
    expect(b).toEqual([]);
    await stopA();
    expect(bus.listenerCount('org_a')).toBe(0);
    await bus.publish('org_a', { projectId: 'p2' });
    expect(a).toHaveLength(1);
  });
});

describe('redis bus', () => {
  it('shares one subscription per channel and isolates organisations', async () => {
    const redis = fakeRedis();
    const bus = createRedisProjectEventBus({ connect: redis.connect, prefix: 'studio', logger });
    const a1: string[] = [];
    const a2: string[] = [];
    const b: string[] = [];
    const stop1 = await bus.subscribe('org_a', (c) => a1.push(c.projectId));
    const stop2 = await bus.subscribe('org_a', (c) => a2.push(c.projectId));
    await bus.subscribe('org_b', (c) => b.push(c.projectId));
    await bus.publish('org_a', { projectId: 'p1' });
    expect(a1).toEqual(['p1']);
    expect(a2).toEqual(['p1']);
    expect(b).toEqual([]);
    const subscriber = redis.clients.find((c) => c.channels.size > 0);
    expect([...(subscriber?.channels ?? [])].sort()).toEqual([
      'studio:live:org:org_a',
      'studio:live:org:org_b',
    ]);
    await stop1();
    expect(subscriber?.channels.has('studio:live:org:org_a')).toBe(true);
    await stop2();
    expect(subscriber?.channels.has('studio:live:org:org_a')).toBe(false);
    bus.close();
    expect(redis.clients.every((c) => c.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it('ignores malformed messages and never throws when publishing fails', async () => {
    const redis = fakeRedis();
    const bus = createRedisProjectEventBus({ connect: redis.connect, prefix: 'p', logger });
    const seen: string[] = [];
    await bus.subscribe('org', (c) => seen.push(c.projectId));
    const sub = redis.clients[0];
    await sub?.publish('p:live:org:org', 'garbage');
    expect(seen).toEqual([]);
    await bus.publish('org', { projectId: 'warm-up' });
    const pub = redis.clients[1];
    if (pub) pub.failPublish = true;
    await expect(bus.publish('org', { projectId: 'x' })).resolves.toBeUndefined();
    expect(seen).toEqual(['warm-up']);
  });

  it('forgets a channel whose subscribe failed', async () => {
    const bus = createRedisProjectEventBus({
      connect: () => ({
        publish: async () => 0,
        subscribe: async () => {
          throw new Error('no redis');
        },
        unsubscribe: async () => undefined,
        on: () => undefined,
        disconnect: () => undefined,
      }),
      prefix: 'p',
      logger,
    });
    await expect(bus.subscribe('org', () => undefined)).rejects.toThrow('no redis');
    await expect(bus.subscribe('org', () => undefined)).rejects.toThrow('no redis');
  });
});
