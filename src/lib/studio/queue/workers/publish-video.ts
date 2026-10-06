import type { Prisma, VideoPublication, VideoRender } from '@prisma/client';
import { NotFoundError, PlatformError } from '../../../errors';
import { nextMidnight } from '../../automation/zoned-time';
import { ensureRenderSrt } from '../../overlays/voice-captions';
import type { PublishRequest } from '../../platforms/interface';
import { readThumbnail } from '../../services/thumbnails';
import type { PipelineDeps } from '../../pipeline/deps';
import { notifyPublicationFailed, notifyTikTokDraftSent } from '../../notifications/events';
import { recordPublished, recordPublishFailed } from '../../observability/slo';
import {
  carouselSlideSources,
  noteCredentialFailure,
  publicationMetadata,
  resolveCredentials,
  videoSource,
} from '../../platforms/publishing';
import { carouselComposition } from '../../carousel/publishing';
import type { Platform } from '../../services/catalog';
import { jobIds } from '../enqueue';
import type { PublishJobData } from '../queues';

// BACKLOG 5.9 — publish one render to one platform account (spec 4.5 step 9, 9.2–9.7):
// SCHEDULED → PUBLISHING → PUBLISHED | FAILED; Engagement attribution; project roll-up to
// PUBLISHED / PARTIALLY_PUBLISHED once no publication of the project is still pending.

const PENDING_STATES = ['SCHEDULED', 'PUBLISHING'] as const;

/** 15.A9: YouTube Data API quota resets at midnight Pacific Time. */
export const YOUTUBE_QUOTA_TIMEZONE = 'America/Los_Angeles';
/** A few minutes past the reset, so the retry does not race the quota rollover. */
const QUOTA_RESET_MARGIN_MS = 5 * 60_000;

function isYouTube(platform: string): boolean {
  return platform === 'youtube' || platform === 'youtube_short';
}

/**
 * 15.A9 (spec 9.4 "quotaExceeded → back off to next quota window"): a YouTube quota refusal
 * (nothing was uploaded) puts the publication back to SCHEDULED and re-queues it just after the
 * next Pacific-midnight reset instead of failing it.
 */
export async function deferForQuota(
  data: PublishJobData,
  deps: PipelineDeps,
  publication: Pick<VideoPublication, 'id' | 'retryCount'>,
  meta: Record<string, unknown>,
): Promise<Date> {
  const at = new Date(nextMidnight(deps.now(), YOUTUBE_QUOTA_TIMEZONE) + QUOTA_RESET_MARGIN_MS);
  const deferrals = typeof meta.quotaDeferrals === 'number' ? meta.quotaDeferrals + 1 : 1;
  await deps.db.videoPublication.update({
    where: { id: publication.id },
    data: {
      state: 'SCHEDULED',
      scheduledFor: at,
      // 17.9: `<code>: <English>` — the UI translates the code.
      errorReason:
        'youtube_quota_deferred: YouTube upload quota reached; retrying after the daily reset',
      errorCode: 'quota_exceeded',
      metadata: {
        ...meta,
        quotaDeferredUntil: at.toISOString(),
        quotaDeferrals: deferrals,
      } as Prisma.InputJsonValue,
    },
  });
  await deps.queue.add('publish-video', data, {
    jobId: `publish-video__${publication.id}__quota__${at.getTime()}`,
    delayMs: at.getTime() - deps.now(),
  });
  deps.audit({
    actorUserId: 'system:studio-publisher',
    organisationId: data.organisationId,
    action: 'studio.publication.quota_deferred',
    resource: { type: 'video_publication', id: publication.id },
    metadata: { retryAt: at.toISOString(), deferrals },
  });
  return at;
}

/** 15.A3 / 15.A4: YouTube extras — custom thumbnail and (long-form) the narration SRT. */
async function youtubeExtras(
  deps: PipelineDeps,
  render: VideoRender,
  organisationId: string,
): Promise<Pick<PublishRequest, 'thumbnail' | 'captions'>> {
  const out: Pick<PublishRequest, 'thumbnail' | 'captions'> = {};
  const bucket = deps.publishing.thumbnailsBucket;
  if (bucket) {
    const thumbnail = await readThumbnail({ storage: deps.storage, bucket }, render).catch(
      () => null,
    );
    if (thumbnail) out.thumbnail = thumbnail;
  }
  if (render.targetPlatform === 'youtube') {
    const srt = await ensureRenderSrt(deps, render, organisationId).catch((err: unknown) => {
      deps.logger.warn(
        { err, renderId: render.id },
        'caption track unavailable; publishing without it',
      );
      return null;
    });
    if (srt)
      out.captions = {
        srt: srt.captions.srt,
        language: srt.captions.language,
        name: 'Studio narration',
      };
  }
  return out;
}

/** Platform errors that mean the upload was refused outright (so nothing can be live). */
function definitelyNotPosted(err: unknown): boolean {
  return (
    err instanceof PlatformError &&
    err.errorClass !== 'timeout' &&
    err.errorClass !== 'unknown' &&
    err.errorClass !== 'outcome_unknown'
  );
}

/** Project roll-up: PUBLISHED if every non-cancelled publication succeeded, else PARTIALLY_PUBLISHED. */
export async function rollUpProject(
  deps: Pick<PipelineDeps, 'db'>,
  projectId: string,
  organisationId: string,
): Promise<void> {
  const pubs = await deps.db.videoPublication.findMany({
    where: { projectId, organisationId, state: { notIn: ['CANCELLED'] } },
    select: { state: true },
  });
  if (
    pubs.length === 0 ||
    pubs.some((p) => (PENDING_STATES as readonly string[]).includes(p.state))
  )
    return;
  const published = pubs.filter((p) => p.state === 'PUBLISHED' || p.state === 'TAKEN_DOWN').length;
  const state =
    published === pubs.length
      ? 'PUBLISHED'
      : published > 0
        ? 'PARTIALLY_PUBLISHED'
        : 'PARTIALLY_PUBLISHED';
  await deps.db.videoProject.updateMany({
    where: { id: projectId, organisationId, state: 'PUBLISHING' },
    data: { state, ...(state === 'PUBLISHED' && { completedAt: new Date() }) },
  });
}

/** Throws KillSwitchTriggeredError (level 'platform') while publishing to `platform` is halted. */
async function assertPlatformNotKilled(
  deps: PipelineDeps,
  data: PublishJobData,
  platform: string,
): Promise<void> {
  await deps.killSwitch.assertNotKilled({
    organisationId: data.organisationId,
    projectId: data.projectId,
    platform,
  });
}

export async function publishVideo(data: PublishJobData, deps: PipelineDeps): Promise<void> {
  const log = deps.logger.child({
    publicationId: data.publicationId,
    organisationId: data.organisationId,
  });
  const publication = await deps.db.videoPublication.findFirst({
    where: { id: data.publicationId, organisationId: data.organisationId },
    include: { render: true },
  });
  if (!publication) throw new NotFoundError('Publication not found');
  if (publication.state !== 'SCHEDULED' && publication.state !== 'PUBLISHING') {
    return log.info({ state: publication.state }, 'publication no longer pending; skipped');
  }
  // Per-platform kill switch, checked before the upload marker is set or anything is claimed:
  // a halted publication fails as kill_switch_platform and is safe to re-drive later.
  await assertPlatformNotKilled(deps, data, publication.platform);
  // CAS SCHEDULED → PUBLISHING (a BullMQ retry of this same job finds it already PUBLISHING).
  if (publication.state === 'SCHEDULED') {
    const moved = await deps.db.videoPublication.updateMany({
      where: { id: publication.id, state: 'SCHEDULED' },
      data: { state: 'PUBLISHING', errorReason: null, errorCode: null },
    });
    if (moved.count === 0) return log.info('publication claimed by another worker; skipped');
  }

  const platform = publication.platform as Platform;
  const { uploadStartedAt, ...meta } = publicationMetadata(publication);
  // Never post twice: an earlier attempt reached the platform but its result was never recorded
  // (crash, DB failure after upload, ambiguous timeout). The post may be live, so stop and let a
  // person check the platform; an explicit retry (retryPublication) clears the marker.
  if (uploadStartedAt) {
    throw new PlatformError(
      platform,
      'outcome_unknown',
      `An upload started at ${uploadStartedAt} did not record its result. Check ${platform} for the post before retrying, so it is not published twice.`,
      false,
    );
  }
  // 21.6: a carousel render publishes its slides as images; everything else is a video.
  const carousel = carouselComposition(publication.render.composition);
  const publisher = deps.publishing.publishers[platform];
  if (carousel && !publisher?.publishCarousel)
    throw new PlatformError(platform, 'invalid_request', `${platform} takes no carousels`, false);
  const { accessToken, accountId, scopes, tiktokPostMode } = await resolveCredentials(
    deps.publishing,
    publication,
  );
  const video = carousel ? null : await videoSource(deps.publishing, publication.render);
  const slides = carousel ? await carouselSlideSources(deps.publishing, carousel) : null;
  const extras =
    !carousel && isYouTube(platform)
      ? await youtubeExtras(deps, publication.render, data.organisationId)
      : {};
  const setMetadata = (value: Record<string, unknown>) =>
    deps.db.videoPublication.update({
      where: { id: publication.id },
      data: { metadata: value as Prisma.InputJsonValue },
    });
  await setMetadata({ ...meta, uploadStartedAt: new Date(deps.now()).toISOString() });

  let result: Awaited<ReturnType<(typeof deps.publishing.publishers)[Platform]['publish']>>;
  const common = {
    text: publication.caption ?? '',
    caption: meta.rawCaption ?? publication.caption ?? '',
    hashtags: publication.hashtags,
    title: meta.title,
    accessToken,
    accountId,
    options: meta.options,
    ...(scopes && { grantedScopes: scopes }),
    ...(tiktokPostMode && { tiktokPostMode }),
  };
  try {
    if (carousel && slides && publisher.publishCarousel) {
      result = await publisher.publishCarousel({
        ...common,
        slides,
        aiGenerated: carousel.aiGenerated,
      });
    } else if (video) {
      result = await publisher.publish({ ...common, video, aiGenerated: true, ...extras });
    } else {
      throw new PlatformError(platform, 'invalid_request', 'Nothing to publish', false);
    }
  } catch (err) {
    // 15.A9: YouTube quota refusal → back off to the next quota window (nothing was uploaded).
    if (
      isYouTube(platform) &&
      err instanceof PlatformError &&
      err.errorClass === 'quota_exceeded'
    ) {
      const at = await deferForQuota(data, deps, publication, meta);
      await noteCredentialFailure(deps.publishing, publication, err);
      return log.warn({ retryAt: at.toISOString() }, 'YouTube quota reached; publication deferred');
    }
    // The platform answered with a definite rejection: nothing was posted, a retry is safe.
    // Timeouts and unclassified failures keep the marker (the upload may have gone through).
    if (definitelyNotPosted(err)) await setMetadata(meta);
    await noteCredentialFailure(deps.publishing, publication, err);
    throw err;
  }

  try {
    await deps.db.videoPublication.update({
      where: { id: publication.id },
      data: {
        state: 'PUBLISHED',
        platformPostId: result.platformPostId,
        platformUrl: result.platformUrl,
        publishedAt: new Date(deps.now()),
        metadata: {
          ...meta,
          result: result.metadata,
          // 15.A2: an inbox upload is finished by the creator in the TikTok app; 22.7 adds why
          // (inboxReason 'drafts' = the connection chose TikTok drafts) so the UI can say
          // "Sent to TikTok drafts" instead of "Published".
          ...(result.metadata.tiktokMode === 'inbox' && {
            tiktokMode: 'inbox',
            note: result.metadata.note,
            ...(typeof result.metadata.inboxReason === 'string' && {
              inboxReason: result.metadata.inboxReason,
            }),
          }),
          // 22.7: drafts were chosen but the connection lacks video.upload (posted directly).
          ...(typeof result.metadata.draftsUnavailable === 'string' && {
            draftsUnavailable: result.metadata.draftsUnavailable,
            draftsNote: result.metadata.draftsNote,
          }),
        } as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    // The post is live but unrecorded. The marker stays, so retries fail as outcome_unknown
    // instead of uploading again; log the post id for reconciliation.
    log.error(
      { err, platform, platformPostId: result.platformPostId, platformUrl: result.platformUrl },
      'published but the result could not be recorded',
    );
    throw err;
  }
  recordPublished(publication, deps.now()); // 15.D9: approve → live latency, first-attempt rate
  deps.audit({
    actorUserId: 'system:studio-publisher',
    organisationId: data.organisationId,
    action: 'studio.publication.published',
    resource: { type: 'video_publication', id: publication.id },
    metadata: { platform, platformPostId: result.platformPostId },
  });
  await deps.publishing.engagement.attributePublication({
    publicationId: publication.id,
    organisationId: data.organisationId,
    platform,
    platformPostId: result.platformPostId,
  });
  await rollUpProject(deps, publication.projectId, data.organisationId);
  // 22.7: a TikTok inbox upload is not live yet: tell the creator to finish it in the app (with
  // the AI-label reminder, since the inbox init cannot set is_aigc).
  if (result.metadata.tiktokMode === 'inbox')
    await notifyTikTokDraftSent(deps, {
      publicationId: publication.id,
      organisationId: data.organisationId,
      projectId: publication.projectId,
    });
  // Spec 15.2: metrics polling starts 30 s after publish.
  const poll = { ...data, pollNumber: 0 };
  await deps.queue.add('poll-publication-analytics', poll, {
    jobId: jobIds.pollAnalytics(poll),
    delayMs: 30_000,
  });
  log.info({ platform, platformPostId: result.platformPostId }, 'published');
}

export async function onPublishVideoFailed(
  data: PublishJobData,
  deps: PipelineDeps,
  reason: string,
  err?: unknown,
): Promise<void> {
  const errorCode = err instanceof PlatformError ? err.errorClass : 'unknown';
  const updated = await deps.db.videoPublication.updateMany({
    where: {
      id: data.publicationId,
      organisationId: data.organisationId,
      state: { in: ['SCHEDULED', 'PUBLISHING'] },
    },
    data: {
      state: 'FAILED',
      errorReason: reason.slice(0, 2_000),
      errorCode,
      retryCount: { increment: 1 },
    },
  });
  if (updated.count > 0) {
    await recordPublishFailed(deps, data.publicationId); // 15.D9: first-attempt success rate
    deps.audit({
      actorUserId: 'system:studio-publisher',
      organisationId: data.organisationId,
      action: 'studio.publication.failed',
      resource: { type: 'video_publication', id: data.publicationId },
      metadata: { errorCode, reason: reason.slice(0, 500) },
    });
    // Spec 14.4: "Publication failed — notify immediately with retry link".
    await notifyPublicationFailed(deps, {
      publicationId: data.publicationId,
      organisationId: data.organisationId,
      projectId: data.projectId,
      reason,
    });
  }
  await rollUpProject(deps, data.projectId, data.organisationId);
}

/** Early-fire allowance for a scheduled publication's delayed job (clock skew). */
export const SCHEDULE_FIRE_TOLERANCE_MS = 5_000;

/** BACKLOG 5.11 — a scheduled publication's delayed job fired: hand it to the publish queue. */
export async function fireScheduledPublication(
  data: PublishJobData,
  deps: PipelineDeps,
): Promise<void> {
  const target = await deps.db.videoPublication.findFirst({
    where: { id: data.publicationId, organisationId: data.organisationId },
    select: { platform: true },
  });
  // Halted platform: fail before the schedule is consumed (nothing is handed to publish-video).
  if (target) await assertPlatformNotKilled(deps, data, target.platform);
  // BACKLOG 13.9: a rescheduled publication may still have its old delayed job queued. A job
  // carries the time it was scheduled for and fires only while the row still has that time; a
  // job from before 13.9 (no time) fires only once the row's time has come
  // (SCHEDULE_FIRE_TOLERANCE_MS absorbs clock skew between API and worker hosts).
  const fired = await deps.db.scheduledPublication.updateMany({
    where: {
      publicationId: data.publicationId,
      state: 'PENDING',
      scheduledFor: data.scheduledFor
        ? new Date(data.scheduledFor)
        : { lte: new Date(deps.now() + SCHEDULE_FIRE_TOLERANCE_MS) },
    },
    data: { state: 'FIRED' },
  });
  if (fired.count === 0) return; // cancelled, already fired, or moved later (stale job)
  const publication = await deps.db.videoPublication.findFirst({
    where: { id: data.publicationId, organisationId: data.organisationId, state: 'SCHEDULED' },
    select: { retryCount: true },
  });
  if (!publication) return;
  await deps.queue.add('publish-video', data, {
    jobId: jobIds.publishVideo(data, publication.retryCount),
  });
}

export async function onFireScheduledFailed(
  data: PublishJobData,
  deps: PipelineDeps,
  reason: string,
  err?: unknown,
): Promise<void> {
  await onPublishVideoFailed(data, deps, `scheduling failed: ${reason}`, err);
}
