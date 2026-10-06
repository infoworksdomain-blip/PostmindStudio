import { randomUUID } from 'node:crypto';
import type { Prisma, VideoProject } from '@prisma/client';
import type { Logger } from 'pino';
import { ValidationError } from '../../../errors';
import type { PipelineDeps } from '../../pipeline/deps';
import {
  failProject,
  mergeProjectMetadata,
  projectMetadata,
  transitionProject,
} from '../../pipeline/project-state';
import { jsonOutput, runProvider } from '../../pipeline/provider-run';
import { directionOptionsOf, VAGUE_BRIEF_REASON } from '../../pipeline/vague-brief';
import { pendingTopicsOf, RESTRICTED_TOPICS_REASON } from '../../pipeline/restricted-topics';
import {
  blocksGeneration,
  buildScriptSafetyPrompt,
  parseScriptSafety,
  SCRIPT_SAFETY_SCHEMA,
  SCRIPT_SAFETY_SYSTEM_PROMPT,
} from '../../pipeline/script-safety';
import { libraryDepsFrom } from '../../images/library';
import { readCarousel, type StoredCarousel, type StoredPost } from '../../carousel/document';
import { fillCarouselPictures } from '../../carousel/images';
import { loadThreadContext, projectTextGenerator, writeThread } from '../../carousel/writer';
import { generateSlideshowCopy, routedGenerator } from '../../services/caption-suggestions';
import { unsplashUseReporter } from './populate-slideshow';
import { jobIds } from '../enqueue';
import type { ProjectJobData } from '../queues';

// 21.6 — the "plan" step of a CAROUSEL run (from plan-project.ts):
//   1. no posts yet → Claude writes the thread from the brief (carousel/writer.ts). The writer
//      answers the same two questions ideation answers for videos: a brief too vague to write
//      from parks the project in DRAFT with direction options (20.18), and a brief that asks
//      about restricted topics parks it for confirmation (spec 13.3); the review screen shows
//      both, as for a video;
//   2. pictures by meaning for the hook and posts that want one (carousel/images.ts);
//   3. the same pre-generation text-safety gate as videos and slideshows (spec 13.2) over the
//      posts;
//   4. captions and hashtags for each network a carousel can go to (one call, cost-tracked;
//      a failure there never stops the carousel), then ASSETS_QUEUED → render-carousel.

const SAFETY_MAX_TOKENS = 1_000;

async function park(
  deps: PipelineDeps,
  data: ProjectJobData,
  reason: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await transitionProject(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    from: ['PLANNING'],
    to: 'DRAFT',
    data: { errorReason: reason },
  });
  await mergeProjectMetadata(deps.db, { projectId: data.projectId, runId: data.runId, patch });
}

/** Writes the thread; returns null when the run was parked for the owner. */
async function writePosts(
  data: ProjectJobData,
  deps: PipelineDeps,
  project: VideoProject,
  stored: StoredCarousel,
  log: Logger,
): Promise<StoredPost[] | null> {
  const metadata = projectMetadata(project.metadata);
  const brief = project.description?.trim();
  if (!brief) throw new ValidationError('A carousel needs a brief or a thread');
  const context = await loadThreadContext(deps.db, project, deps.now());
  const directionChosen = metadata.directionChosen === true;
  const confirmed = metadata.restrictedTopicsConfirmed === true;
  const thread = await writeThread(projectTextGenerator(deps, data), {
    ...context,
    brief,
    postCount: stored.postCount,
    directionChosen,
    restrictedTopicsConfirmed: confirmed,
  });
  if (!thread.actionable && !directionChosen) {
    await park(deps, data, VAGUE_BRIEF_REASON, {
      directionOptions: directionOptionsOf(thread.directionOptions),
      lastBriefVague: true,
    });
    log.info('carousel brief too vague; returned direction options');
    return null;
  }
  if (thread.restrictedTopicsMentioned.length > 0 && !confirmed) {
    await park(deps, data, RESTRICTED_TOPICS_REASON, {
      pendingRestrictedTopics: pendingTopicsOf(thread.restrictedTopicsMentioned),
    });
    log.info(
      { topics: thread.restrictedTopicsMentioned },
      'carousel restricted topics need confirmation',
    );
    return null;
  }
  return thread.posts.map((p) => ({
    id: randomUUID(),
    text: p.text,
    image: null,
    ...(p.imageQuery && { imageQuery: p.imageQuery }),
  }));
}

async function safetyGate(
  data: ProjectJobData,
  deps: PipelineDeps,
  posts: readonly StoredPost[],
): Promise<string | null> {
  const texts = posts.map((p) => p.text).filter((t) => t.trim().length > 0);
  if (texts.length === 0) return null;
  const run = await runProvider(
    {
      need: { kind: 'capability', capability: 'text_generation' },
      planTier: data.planTier,
      request: {
        capability: 'text_generation',
        task: 'script_safety',
        organisationId: data.organisationId,
        projectId: data.projectId,
        system: SCRIPT_SAFETY_SYSTEM_PROMPT,
        prompt: buildScriptSafetyPrompt([
          { platform: 'instagram_feed', fullText: texts.join('\n\n'), onScreenText: texts },
        ]),
        outputSchema: SCRIPT_SAFETY_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: SAFETY_MAX_TOKENS,
      },
    },
    deps,
  );
  const safety = parseScriptSafety(jsonOutput(run.output));
  await mergeProjectMetadata(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    patch: { scriptSafety: safety },
  });
  return blocksGeneration(safety)
    ? `script_safety_${safety.verdict.toLowerCase()}: ${safety.reason}`
    : null;
}

export async function planCarousel(
  data: ProjectJobData,
  deps: PipelineDeps,
  project: VideoProject,
  log: Logger,
): Promise<void> {
  const stored = readCarousel(project.metadata);
  if (!stored) {
    await failProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      reason: 'carousel_incomplete: no carousel settings',
    });
    return log.warn('carousel project without metadata.carousel');
  }
  const written =
    stored.posts.length > 0 ? null : await writePosts(data, deps, project, stored, log);
  if (stored.posts.length === 0 && !written) return;
  let posts: StoredPost[] = written ?? [...stored.posts];
  const aiWritten = stored.aiWritten || written !== null;
  // Keep the written thread at once: a retry of a later step never pays for it again.
  if (written)
    await mergeProjectMetadata(deps.db, {
      projectId: project.id,
      runId: data.runId,
      patch: { carousel: { ...stored, posts, aiWritten } as unknown as Prisma.InputJsonValue },
    });

  const pictures = await fillCarouselPictures(
    {
      db: deps.db,
      library: libraryDepsFrom(deps),
      providers: deps,
      reportStockUse: unsplashUseReporter(deps.fetch, process.env.UNSPLASH_ACCESS_KEY),
    },
    {
      organisationId: data.organisationId,
      businessId: project.businessId,
      projectId: project.id,
      planTier: data.planTier,
    },
    posts,
  );
  posts = pictures.posts;
  log.info(
    { matched: pictures.matched, stocked: pictures.stocked, generated: pictures.generated },
    'carousel pictures chosen',
  );

  const blocked = await safetyGate(data, deps, posts);
  if (blocked) {
    await failProject(deps.db, { projectId: project.id, runId: data.runId, reason: blocked });
    return log.warn({ blocked }, 'carousel text safety stopped the run');
  }
  const next: StoredCarousel = { ...stored, posts, aiWritten };
  await mergeProjectMetadata(deps.db, {
    projectId: project.id,
    runId: data.runId,
    patch: { carousel: next as unknown as Prisma.InputJsonValue },
  });
  try {
    await generateSlideshowCopy(
      {
        db: deps.db,
        now: deps.now,
        generate: routedGenerator(deps, {
          organisationId: data.organisationId,
          projectId: data.projectId,
          planTier: data.planTier,
        }),
      },
      // The project's formats are the carousel networks (CAROUSEL_TARGET_FORMATS).
      project,
      posts.map((p) => p.text).filter(Boolean),
    );
  } catch (err) {
    log.warn({ err }, 'carousel captions not generated; publishing will top up the hashtags');
  }
  const moved = await transitionProject(deps.db, {
    projectId: project.id,
    runId: data.runId,
    from: ['PLANNING'],
    to: 'ASSETS_QUEUED',
  });
  if (!moved) return log.info('carousel run superseded before rendering');
  await deps.queue.add('render-carousel', data, { jobId: jobIds.renderCarousel(data) });
  log.info({ posts: posts.length }, 'carousel planned; rendering');
}
