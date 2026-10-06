import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineDeps } from '../../pipeline/deps';
import type { PublishRequest, PublishResult } from '../../platforms/interface';
import { TIKTOK_DRAFTS_NOTE, TIKTOK_DRAFTS_RECONNECT_NOTE } from '../../platforms/tiktok';
import { TIKTOK_DRAFT_SENT_BODY } from '../../notifications/events';
import { publishVideo } from './publish-video';

// 22.7: the publish worker passes the TikTok connection's posting preference to the publisher,
// stores "sent to TikTok drafts" (not a plain live post) and tells the creator to finish it in
// the app, with the AI-label reminder.

vi.mock('../../platforms/tokens', () => ({ getAccessToken: vi.fn(async () => 'tt-token') }));

type Connection = { tiktokPostMode: string | null; scopes: string[] };

function makeDeps(connection: Connection, result: PublishResult) {
  const update = vi.fn(async () => ({}));
  const publish = vi.fn(async (_request: PublishRequest) => result);
  const notify = vi.fn(async () => ({ created: true }));
  const db = {
    videoPublication: {
      findFirst: vi.fn(async (args: { select?: { project?: unknown } }) =>
        args.select?.project
          ? { project: { name: 'Fresh bread', createdByUserId: 'user_1' } }
          : {
              id: 'pub_1',
              organisationId: 'org_1',
              projectId: 'prj_1',
              platform: 'tiktok',
              platformAccountId: 'open_1',
              state: 'SCHEDULED',
              createdAt: new Date(0),
              updatedAt: new Date(0),
              scheduledFor: null,
              caption: 'Bread #baking',
              hashtags: ['baking'],
              metadata: { connectionId: 'conn_1' },
              render: {
                id: 'r1',
                s3Bucket: 'renders',
                s3Key: 'r1.mp4',
                durationSec: 20,
                aspectRatio: '9:16',
                composition: null,
              },
            },
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update,
      findMany: vi.fn(async () => [{ state: 'PUBLISHED' }]),
    },
    videoProject: { updateMany: vi.fn(async () => ({ count: 1 })) },
    platformConnection: {
      findFirst: vi.fn(async () => ({
        id: 'conn_1',
        organisationId: 'org_1',
        platform: 'tiktok',
        platformAccountId: 'open_1',
        state: 'active',
        ...connection,
      })),
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = {
    db,
    logger: { ...logger, child: () => logger },
    notifier: { notify, notifyStaff: vi.fn() },
    now: () => 0,
    killSwitch: { assertNotKilled: vi.fn() },
    audit: vi.fn(),
    queue: { add: vi.fn() },
    publishing: {
      db,
      publishers: { tiktok: { publish } },
      storage: {
        size: vi.fn(async () => 10),
        signedUrl: vi.fn(async () => 'https://cdn/r1.mp4'),
        readRange: vi.fn(async () => new Uint8Array([1])),
      },
      engagement: { attributePublication: vi.fn() },
      logger,
      now: () => 0,
    },
  } as unknown as PipelineDeps;
  return { deps, update, publish, notify };
}

const data = {
  publicationId: 'pub_1',
  projectId: 'prj_1',
  organisationId: 'org_1',
  runId: 'r',
  planTier: 'BASIC' as const,
};

const BOTH = ['user.info.basic', 'video.publish', 'video.upload'];
const draftResult: PublishResult = {
  platformPostId: 'draft-1',
  platformUrl: null,
  metadata: {
    publishId: 'draft-1',
    tiktokMode: 'inbox',
    inboxReason: 'drafts',
    inboxStatus: 'SEND_TO_USER_INBOX',
    note: TIKTOK_DRAFTS_NOTE,
  },
};

function storedMetadata(update: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const last = update.mock.calls.at(-1)?.[0] as { data: { metadata: Record<string, unknown> } };
  return last.data.metadata;
}

describe('publishVideo → TikTok drafts (22.7)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes "drafts" from the connection, stores the drafts state and notifies the creator', async () => {
    const { deps, update, publish, notify } = makeDeps(
      { tiktokPostMode: 'drafts', scopes: BOTH },
      draftResult,
    );

    await publishVideo(data, deps);

    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      tiktokPostMode: 'drafts',
      grantedScopes: BOTH,
      accessToken: 'tt-token',
    });
    expect(storedMetadata(update)).toMatchObject({
      tiktokMode: 'inbox',
      inboxReason: 'drafts',
      note: TIKTOK_DRAFTS_NOTE,
    });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'tiktok_draft',
        userId: 'user_1',
        title: '“Fresh bread” is in your TikTok drafts',
        body: TIKTOK_DRAFT_SENT_BODY,
        link: '/projects/prj_1',
        dedupeKey: 'tiktok_draft:pub_1',
        message: { key: 'tiktokDraftSent', params: { name: 'Fresh bread' } },
      }),
    );
    expect(TIKTOK_DRAFT_SENT_BODY).toContain('"AI-generated content" label switched on');
  });

  it('a connection from before 22.7 (NULL) posts directly with no drafts notification', async () => {
    const { deps, publish, notify } = makeDeps(
      { tiktokPostMode: null, scopes: BOTH },
      { platformPostId: '1', platformUrl: null, metadata: { tiktokMode: 'direct' } },
    );

    await publishVideo(data, deps);

    expect(publish.mock.calls[0]?.[0]).toMatchObject({ tiktokPostMode: 'direct' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps the "Reconnect TikTok to send drafts" flag when drafts fell back to direct', async () => {
    const { deps, update, notify } = makeDeps(
      { tiktokPostMode: 'drafts', scopes: ['video.publish'] },
      {
        platformPostId: '2',
        platformUrl: null,
        metadata: {
          tiktokMode: 'direct',
          draftsUnavailable: 'missing_scope',
          draftsNote: TIKTOK_DRAFTS_RECONNECT_NOTE,
        },
      },
    );

    await publishVideo(data, deps);

    expect(storedMetadata(update)).toMatchObject({
      draftsUnavailable: 'missing_scope',
      draftsNote: TIKTOK_DRAFTS_RECONNECT_NOTE,
    });
    expect(notify).not.toHaveBeenCalled();
  });
});
