import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as analyticsPublicationRoute from '../../src/app/api/studio/analytics/publications/[id]/route';
import * as internalChannelsRoute from '../../src/app/api/studio/internal/channels/route';
import * as refreshedRoute from '../../src/app/api/studio/internal/tokens/refreshed/route';
import * as connectionsRoute from '../../src/app/api/studio/platform-connections/route';
import { createInstagramMetrics } from '../../src/lib/studio/analytics/fetchers';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { InstagramReelPublisher } from '../../src/lib/studio/platforms/meta';
import { createStoredMetaCredentials } from '../../src/lib/studio/platforms/meta-credentials';
import { call } from '../helpers/api-harness';
import { json } from '../helpers/fake-fetch';
import {
  approve,
  briefBody,
  cleanupGolden,
  createProject,
  drain,
  generate,
  getPublication,
  publish,
  rendersOf,
  startJourney,
} from './journey-kit';

// Operator decision 2026-09-27 (Meta): PostMind Core runs the Meta login and pushes the tokens
// to Studio's internal endpoints, exactly as it does for Engagement (handover 9.5 / 14.13).
//
//   META-01  Core registers an Instagram account → brief → generate → approve → publish a Reel
//            through the real InstagramReelPublisher (Graph API faked at fetch level) using the
//            token Core pushed → metrics polled through the real Instagram insights reader.
//   META-02  Meta rejects the token (error 190) during a poll → the channel is needs_reconnect →
//            Core's refresh job pushes a new token → the channel is active again.

const hasDb = Boolean(process.env.DATABASE_URL);
const SERVICE_TOKEN = 'core-service-token-'.padEnd(48, 'x');
const IG_USER = `1784140${String(Date.now()).slice(-8)}`;
/** Media ids are unique per (platform, post id) across the table: one per journey and run. */
const mediaIdFor = (n: number) => `18${String(Date.now()).slice(-10)}${n}`;

type Recorded = { method: string; url: URL; params: URLSearchParams };

/** Graph API stand-in: routes by method + path, records every call (with the token it carried). */
function fakeGraph(mediaId: string, insights: () => Response) {
  const calls: Recorded[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const params =
      method === 'GET' ? url.searchParams : new URLSearchParams(String(init?.body ?? ''));
    calls.push({ method, url, params });
    const path = url.pathname.replace(/^\/v\d+\.\d+/, '');
    if (method === 'POST' && path === `/${IG_USER}/media`) return json({ id: 'container-1' });
    if (method === 'GET' && path === '/container-1') return json({ status_code: 'FINISHED' });
    if (method === 'POST' && path === `/${IG_USER}/media_publish`) return json({ id: mediaId });
    if (method === 'GET' && path === `/${mediaId}`)
      return json({
        permalink: `https://www.instagram.com/reel/${mediaId}/`,
        shortcode: mediaId,
        timestamp: '2026-09-27T12:00:00+0000',
      });
    if (method === 'GET' && path === `/${mediaId}/insights`) return insights();
    return json({ error: { message: `unexpected ${method} ${path}`, code: 100 } }, 400);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const insight = (name: string, value: number) => ({
  name,
  period: 'lifetime',
  values: [{ value }],
  title: name,
  id: `media/insights/${name}/lifetime`,
});

describe.skipIf(!hasDb)('golden journeys: Meta (Instagram Reels)', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    setApiDeps(undefined);
    await cleanupGolden(db, since);
    await db.$disconnect();
  }, 120_000);

  /** A journey wired with the production Meta credential source, publisher and reader. */
  let journeys = 0;
  function metaJourney(id: string, insights: () => Response) {
    vi.stubEnv('STUDIO_INTERNAL_SERVICE_TOKEN', SERVICE_TOKEN);
    const j = startJourney(db, id);
    journeys += 1;
    const mediaId = mediaIdFor(journeys);
    const graph = { ...fakeGraph(mediaId, insights), mediaId };
    const publishing = j.h.deps.publishing;
    publishing.meta = createStoredMetaCredentials({ db, keys: j.h.keys, now: Date.now });
    publishing.publishers.instagram_reel = new InstagramReelPublisher({
      fetchImpl: graph.fetchImpl,
      sleep: async () => undefined,
      now: Date.now,
    });
    j.h.deps.metrics.instagram_reel = createInstagramMetrics({ fetchImpl: graph.fetchImpl });
    j.h.queue.defer.add('poll-publication-analytics');
    return { j, graph };
  }

  const coreRegisters = (org: string, accessToken: string) =>
    call(internalChannelsRoute.POST, {
      method: 'POST',
      path: '/api/studio/internal/channels',
      headers: { 'x-service-token': SERVICE_TOKEN },
      body: {
        organisationId: org,
        platform: 'instagram',
        platformAccountId: IG_USER,
        platformAccountName: '@leeds.sourdough',
        accessToken,
        tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
        scopes: ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights'],
      },
    });

  async function publishedReel(id: string, insights: () => Response) {
    const { j, graph } = metaJourney(id, insights);
    const registered = await coreRegisters(j.org, 'EAAG-core-token-one');
    expect(registered.status).toBe(201);
    const channel = registered.json.channel as { id: string };

    // The user sees the account (read-only) in Studio's connection list.
    const list = await call(connectionsRoute.GET, { token: 'reader' });
    expect(list.json.data).toEqual([
      expect.objectContaining({ id: channel.id, platform: 'instagram', businessId: null }),
    ]);

    const projectId = await createProject(
      j,
      briefBody({
        targetFormats: [{ platform: 'instagram_reel', aspectRatio: '9:16', durationSec: 15 }],
      }),
    );
    expect((await generate(j, projectId)).state).toBe('READY_FOR_REVIEW');
    await approve(j, projectId);
    const [render] = await rendersOf(j, projectId);
    const pubId = await publish(j, {
      renderId: render?.id,
      platform: 'instagram_reel',
      connectionId: channel.id,
      caption: 'Fresh from the oven',
      hashtags: ['sourdough'],
    });
    await drain(j);
    return { j, graph, pubId, channel };
  }

  it('META-01 Core registers Instagram → approve → publish a Reel → metrics polled', async () => {
    const { j, graph, pubId } = await publishedReel('meta01', () =>
      json({
        data: [
          insight('views', 1520),
          insight('reach', 980),
          insight('likes', 64),
          insight('comments', 7),
          insight('shares', 12),
          insight('saved', 9),
        ],
      }),
    );

    const publication = await getPublication(j, pubId);
    expect(publication).toMatchObject({ state: 'PUBLISHED', platformPostId: graph.mediaId });
    // The Graph calls carried the token Core pushed, decrypted from platform_connections.
    const container = graph.calls.find(
      (c) => c.method === 'POST' && c.url.pathname.endsWith('/media'),
    );
    expect(container?.params.get('access_token')).toBe('EAAG-core-token-one');
    expect(container?.params.get('media_type')).toBe('REELS');
    expect(container?.params.get('caption')).toContain('#sourdough');
    expect(j.h.attributions).toEqual([
      expect.objectContaining({ publicationId: pubId, platformPostId: graph.mediaId }),
    ]);

    // Spec 15.2: the first poll is queued 30 s after publishing.
    expect(j.h.queue.deferred.map((d) => d.name)).toEqual(['poll-publication-analytics']);
    expect(j.h.queue.release('poll-publication-analytics')).toBe(1);
    await drain(j);
    const insightsCall = graph.calls.find((c) => c.url.pathname.endsWith('/insights'));
    expect(insightsCall?.params.get('metric')).toBe('views,reach,likes,comments,shares,saved');
    expect(insightsCall?.params.get('access_token')).toBe('EAAG-core-token-one');
    const detail = await call(analyticsPublicationRoute.GET, {
      token: 'reader',
      params: { id: pubId },
    });
    expect(detail.status).toBe(200);
    expect(detail.json.latest).toMatchObject({
      views: 1520,
      uniqueViewers: 980,
      likes: 64,
      comments: 7,
      shares: 12,
      saves: 9,
    });
    expect(j.h.queue.deferred).toHaveLength(1); // polling continues on schedule
  });

  it('META-02 a rejected token marks the channel needs_reconnect until Core refreshes it', async () => {
    let tokenRejected = true;
    const { j, pubId, channel } = await publishedReel('meta02', () =>
      tokenRejected
        ? json({ error: { message: 'Session has expired', code: 190, error_subcode: 463 } }, 400)
        : json({ data: [insight('views', 10)] }),
    );
    expect((await getPublication(j, pubId)).state).toBe('PUBLISHED');

    expect(j.h.queue.release('poll-publication-analytics')).toBe(1);
    await drain(j);
    const flagged = await db.platformConnection.findUniqueOrThrow({ where: { id: channel.id } });
    expect(flagged.state).toBe('needs_reconnect');
    const pub = await db.videoPublication.findUniqueOrThrow({ where: { id: pubId } });
    expect(
      (pub.metadata as { analytics?: { unavailable?: string } }).analytics?.unavailable,
    ).toMatch(/expired/i);

    // Core's nightly refresh job pushes a fresh token: the channel is usable again.
    tokenRejected = false;
    const refreshed = await call(refreshedRoute.POST, {
      method: 'POST',
      headers: { 'x-service-token': SERVICE_TOKEN },
      body: {
        organisationId: j.org,
        platform: 'instagram',
        platformAccountId: IG_USER,
        accessToken: 'EAAG-core-token-two',
      },
    });
    expect(refreshed.status).toBe(200);
    const credentials = await j.h.deps.publishing.meta.getCredentials({
      organisationId: j.org,
      platform: 'instagram',
      platformAccountId: IG_USER,
    });
    expect(credentials.accessToken).toBe('EAAG-core-token-two');
    expect(
      (await db.platformConnection.findUniqueOrThrow({ where: { id: channel.id } })).state,
    ).toBe('active');
  });
});
