import type { ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
  liveChannel,
  parseProjectChange,
  type ProjectChangeListener,
  type ProjectEventBus,
} from './events';

// BACKLOG 24.2 — the project event bus over Redis pub/sub (Studio's DB 3; pub/sub channels are
// server-wide, so the channel name carries the queue prefix to keep staging and production
// apart when they share a server). One publishing connection per process, and one subscribing
// connection per web process shared by every open SSE stream (reference-counted per channel).
// Publishing never throws: live status is a convenience; the calendar still refreshes itself.

/** The ioredis surface the bus uses (a fake implements it in tests). */
export interface PubSubClient {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  disconnect(): void;
}

export interface RedisBusOptions {
  /** Creates a connection; called once for publishing and once (lazily) for subscribing. */
  connect: (role: 'publisher' | 'subscriber') => PubSubClient;
  prefix: string;
  logger: Logger;
}

export function createRedisProjectEventBus(
  options: RedisBusOptions,
): ProjectEventBus & { close(): void } {
  let publisher: PubSubClient | undefined;
  let subscriber: PubSubClient | undefined;
  const listeners = new Map<string, Set<ProjectChangeListener>>();

  function subscriberClient(): PubSubClient {
    if (subscriber) return subscriber;
    const client = options.connect('subscriber');
    client.on('message', (channel, message) => {
      const change = parseProjectChange(message);
      if (!change) return;
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(change);
    });
    subscriber = client;
    return client;
  }

  return {
    async publish(organisationId, change) {
      publisher ??= options.connect('publisher');
      try {
        await publisher.publish(
          liveChannel(options.prefix, organisationId),
          JSON.stringify({ projectId: change.projectId }),
        );
      } catch (err) {
        options.logger.warn({ err, organisationId }, 'live project event not published');
      }
    },
    async subscribe(organisationId, listener) {
      const channel = liveChannel(options.prefix, organisationId);
      const client = subscriberClient();
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
        try {
          await client.subscribe(channel);
        } catch (err) {
          listeners.delete(channel);
          throw err;
        }
      }
      set.add(listener);
      const own = set;
      return async () => {
        own.delete(listener);
        if (own.size > 0 || listeners.get(channel) !== own) return;
        listeners.delete(channel);
        await client.unsubscribe(channel).catch((err: unknown) => {
          options.logger.warn({ err }, 'live channel unsubscribe failed');
        });
      };
    },
    close() {
      publisher?.disconnect();
      subscriber?.disconnect();
      publisher = undefined;
      subscriber = undefined;
      listeners.clear();
    },
  };
}

/** ioredis connections for the bus: the publisher fails fast, the subscriber reconnects. */
export function redisPubSubConnector(connection: ConnectionOptions) {
  return (role: 'publisher' | 'subscriber'): PubSubClient => {
    const redis = new Redis({
      ...(connection as object),
      ...(role === 'publisher'
        ? { maxRetriesPerRequest: 1, commandTimeout: 1_000 }
        : { maxRetriesPerRequest: null }),
      lazyConnect: false,
    });
    // Failures surface per command; keep ioredis from reporting them as unhandled.
    redis.on('error', () => undefined);
    return redis;
  };
}
