import { ConfigurationError, NotFoundError } from '../../errors';
import type { PipelineDeps } from '../pipeline/deps';
import type { PlanTier } from '../providers/router';
import { nearestAspectRatio } from './analyse';
import {
  analyseContent,
  embeddingDocument,
  storeLibraryEmbedding,
  visualStructure,
} from './ingest';

// BACKLOG 15.D7 / Addendum A3.8 "Re-run ingestion on selected items (e.g. after upgrading the
// OCR or embedding model)". Re-runs steps 2–7 of ingest.ts on the source already stored in the
// library bucket (no re-download), then replaces the analysis row and the embedding.
// What is kept: title, tags, licence, thumbnail/preview (same source bytes) and a category a
// staff member reviewed (ACCEPTED / OVERRIDDEN). An unreviewed category follows the new analysis.

export interface ReanalyseResult {
  libraryItemId: string;
  categoryChanged: boolean;
}

export async function reanalyseLibraryVideo(
  deps: PipelineDeps,
  libraryItemId: string,
  planTier: PlanTier,
): Promise<ReanalyseResult> {
  const item = await deps.db.videoLibraryItem.findUnique({ where: { id: libraryItemId } });
  if (!item) throw new NotFoundError('Library video not found');
  if (!item.s3Bucket || !item.s3Key)
    throw new ConfigurationError('Library video has no stored source to re-analyse');
  const url = await deps.storage.signedUrl(item.s3Bucket, item.s3Key, 6 * 60 * 60);

  const visual = await visualStructure(deps, url);
  const content = await analyseContent(deps, {
    url,
    visual,
    planTier,
    hints: { title: item.title, tags: item.tags },
  });
  const keepCategory = item.categoryReview === 'ACCEPTED' || item.categoryReview === 'OVERRIDDEN';
  const categoryId = keepCategory
    ? item.categoryId
    : (content.suggestedCategoryId ?? item.categoryId);
  const now = new Date(deps.now());

  await deps.db.$transaction(async (tx) => {
    await tx.videoLibraryAnalysis.upsert({
      where: { libraryItemId },
      create: { libraryItemId, ...content.analysisRow },
      update: content.analysisRow,
    });
    await tx.videoLibraryItem.update({
      where: { id: libraryItemId },
      data: {
        description: content.analysis.description,
        categoryId,
        durationSec: visual.probe.durationSec,
        aspectRatio: nearestAspectRatio(visual.probe.width, visual.probe.height),
        reanalysedAt: now,
      },
    });
  });

  await storeLibraryEmbedding(
    deps,
    libraryItemId,
    embeddingDocument({
      title: item.title,
      description: content.analysis.description,
      tags: item.tags,
      analysis: content.analysis,
      transcript: content.transcript.text,
    }),
    planTier,
    true,
  );
  return { libraryItemId, categoryChanged: categoryId !== item.categoryId };
}
