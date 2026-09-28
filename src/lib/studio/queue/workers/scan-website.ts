import { NotFoundError } from '../../../errors';
import { buildStockLayer, embedMissing, libraryDepsFrom } from '../../images/library';
import { ingestImage, looksLikeIconOrTracker, MAX_IMAGE_BYTES } from '../../images/ingest';
import type { PipelineDeps } from '../../pipeline/deps';
import { runProvider } from '../../pipeline/provider-run';
import {
  BUSINESS_PROFILE_SCHEMA,
  buildClassifyPrompt,
  CLASSIFY_SYSTEM_PROMPT,
  parseClassifiedProfile,
  type ClassifiedProfile,
} from '../../scan/classify';
import { crawlSite } from '../../scan/crawl';
import type { HeadlessRenderer } from '../../scan/headless-render';
import type { ExtractedImage } from '../../scan/extract';
import { PoliteFetcher } from '../../scan/fetch';
import type { LibraryRefreshJobData, ScanJobData } from '../queues';

// BACKLOG 6.1–6.4 — one website scan (Addendum A6.2 + A6.3):
// crawl → classify (Claude) → BusinessProfile → Layer 1 scraped images → Layer 2 stock →
// embeddings. The scan row records pages, images, robots refusal, JS rendering and errors.

const MAX_SCRAPED_IMAGES = 60;

const libraryDeps = libraryDepsFrom;

function jsonOutput(metadata: unknown): unknown {
  return (metadata as { json?: unknown } | null)?.json;
}

async function saveProfile(
  deps: PipelineDeps,
  data: ScanJobData,
  profile: ClassifiedProfile,
  model: string,
) {
  const existing = await deps.db.businessProfile.findUnique({
    where: {
      organisationId_businessId: {
        organisationId: data.organisationId,
        businessId: data.businessId,
      },
    },
  });
  const fields = {
    industry: profile.industry,
    subNiche: profile.subNiche,
    products: profile.products,
    services: profile.services,
    audienceKeywords: profile.audienceKeywords,
    toneIndicators: profile.toneIndicators,
    regions: profile.regions,
    imageThemes: profile.imageThemes,
    imageSearchQueries: profile.searchQueries,
    restrictedTopics: profile.restrictedTopics,
    brandVoiceSummary: profile.brandVoiceSummary || null,
    classifierModel: model,
    lastRefreshedAt: new Date(deps.now()),
  };
  if (!existing) {
    return deps.db.businessProfile.create({
      data: { organisationId: data.organisationId, businessId: data.businessId, ...fields },
    });
  }
  // A user-edited profile is the user's: a refresh records the new classification time only.
  return deps.db.businessProfile.update({
    where: { id: existing.id },
    data: existing.editedByUser
      ? { lastRefreshedAt: fields.lastRefreshedAt }
      : { ...fields, classifierVersion: { increment: 1 } },
  });
}

async function ingestScraped(
  deps: PipelineDeps,
  data: ScanJobData,
  fetcher: PoliteFetcher,
  images: ExtractedImage[],
  themes: string[],
): Promise<{ created: number; errors: string[] }> {
  let created = 0;
  const errors: string[] = [];
  const seen = new Set<string>();
  const candidates = images.filter((img) => {
    if (seen.has(img.url) || looksLikeIconOrTracker(img)) return false;
    seen.add(img.url);
    return true;
  });
  for (const image of candidates.slice(0, MAX_SCRAPED_IMAGES)) {
    try {
      const res = await fetcher.download(image.url, MAX_IMAGE_BYTES + 1);
      if (!res || res.status >= 400 || res.truncated) continue;
      const outcome = await ingestImage(
        { ...libraryDeps(deps) },
        {
          organisationId: data.organisationId,
          businessId: data.businessId,
          source: 'SCRAPED',
          sourceUrl: image.url,
          sourceProvider: 'website',
          bytes: res.body,
          altText: image.alt ?? image.caption,
          tags: [...(image.alt ? [image.alt] : []), ...themes.slice(0, 3)],
          licenseNotes: `Scraped from ${image.pageUrl}; ownership warranted by the user at scan start`,
        },
      );
      if (outcome.status === 'created') created += 1;
    } catch (err) {
      errors.push(`${image.url}: ${(err as Error).message}`.slice(0, 300));
    }
  }
  return { created, errors };
}

/** The browser-render fallback, only for a scan whose owner confirmed ownership of the site. */
export function headlessFor(
  scan: { ownershipConfirmedAt: Date | null },
  headless: HeadlessRenderer | undefined,
): HeadlessRenderer | undefined {
  return scan.ownershipConfirmedAt ? headless : undefined;
}

export async function scanWebsite(data: ScanJobData, deps: PipelineDeps): Promise<void> {
  const log = deps.logger.child({ scanId: data.scanId, organisationId: data.organisationId });
  const scan = await deps.db.websiteScan.findFirst({
    where: { id: data.scanId, organisationId: data.organisationId },
  });
  if (!scan) throw new NotFoundError('Scan not found');
  if (scan.state === 'SUCCEEDED' || scan.state === 'FAILED') {
    return log.info({ state: scan.state }, 'scan already finished; skipped');
  }
  await deps.db.websiteScan.update({ where: { id: scan.id }, data: { state: 'RUNNING' } });

  const fetcher = new PoliteFetcher({
    fetchImpl: deps.scan.pageFetch,
    sleep: deps.sleep,
    now: deps.now,
    random: deps.scan.random,
  });
  const crawl = await crawlSite(scan.url, {
    fetcher,
    renderer: deps.scan.renderer,
    // 14.4 policy: the browser-render fallback for a refused homepage is used ONLY when the
    // business owner confirmed they own or represent this site (stored on the scan). It is never
    // a way round a third party's bot protection (runbooks/scan-blocked.md).
    headless: headlessFor(scan, deps.scan.headless),
  });
  if (crawl.robotsBlocked || crawl.pages.length === 0) {
    await deps.db.websiteScan.update({
      where: { id: scan.id },
      data: {
        state: 'FAILED',
        robotsBlocked: crawl.robotsBlocked,
        errorReason: crawl.robotsBlocked
          ? "The site's robots.txt does not allow PostMindStudio to fetch the homepage"
          : 'No pages could be fetched',
        completedAt: new Date(deps.now()),
      },
    });
    return;
  }
  await deps.db.websiteScan.update({
    where: { id: scan.id },
    data: { pagesCrawled: crawl.pages.length, usedJsRender: crawl.usedJsRender },
  });

  const run = await runProvider(
    {
      need: { kind: 'capability', capability: 'text_generation' },
      planTier: data.planTier,
      request: {
        capability: 'text_generation',
        organisationId: data.organisationId,
        system: CLASSIFY_SYSTEM_PROMPT,
        prompt: buildClassifyPrompt({ siteUrl: scan.url, pages: crawl.pages }),
        maxTokens: 2_000,
        outputSchema: BUSINESS_PROFILE_SCHEMA as unknown as Record<string, unknown>,
      },
    },
    deps,
  );
  const classified = parseClassifiedProfile(jsonOutput(run.output.metadata));
  const metadata = run.output.metadata as { model?: string; costPence?: number };
  const profile = await saveProfile(
    deps,
    data,
    classified,
    `${run.decision.adapter.providerId}:${metadata.model ?? 'unknown'}`,
  );

  const scraped = await ingestScraped(
    deps,
    data,
    fetcher,
    crawl.pages.flatMap((p) => p.images),
    profile.imageThemes,
  );
  const stock = await buildStockLayer(libraryDeps(deps), data, {
    queries: profile.imageSearchQueries,
    themes: profile.imageThemes,
  }).catch((err: Error) => ({ created: 0, duplicates: 0, skipped: 0, errors: [err.message] }));
  const embedded = await embedMissing({ db: deps.db, providers: deps }, data);

  const errors = [...crawl.errors, ...scraped.errors, ...stock.errors];
  await deps.db.websiteScan.update({
    where: { id: scan.id },
    data: {
      state: 'SUCCEEDED',
      // A6.6: homepage validators for the next scheduled rescan's conditional request.
      etag: crawl.etag?.slice(0, 500) ?? null,
      lastModified: crawl.lastModified?.slice(0, 100) ?? null,
      imagesIngested: scraped.created + stock.created,
      costPence: (metadata.costPence ?? 0) + embedded.costPence,
      errorReason: errors.length ? errors.slice(0, 20).join('\n').slice(0, 4_000) : null,
      completedAt: new Date(deps.now()),
    },
  });
  log.info(
    { pages: crawl.pages.length, scraped: scraped.created, stock: stock.created },
    'website scan finished',
  );
}

export async function onScanWebsiteFailed(
  data: ScanJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  await deps.db.websiteScan.updateMany({
    where: {
      id: data.scanId,
      organisationId: data.organisationId,
      state: { in: ['QUEUED', 'RUNNING'] },
    },
    data: { state: 'FAILED', errorReason: reason.slice(0, 2_000), completedAt: new Date() },
  });
}

/** A6.6 — stock refresh (manual trigger or weekly delta): re-run queries, embed new rows. */
export async function refreshImageLibrary(
  data: LibraryRefreshJobData,
  deps: PipelineDeps,
): Promise<void> {
  const profile = await deps.db.businessProfile.findFirst({
    where: { businessId: data.businessId, organisationId: data.organisationId },
  });
  const queries = data.queries?.length ? data.queries : (profile?.imageSearchQueries ?? []);
  if (queries.length === 0) {
    return deps.logger.info({ businessId: data.businessId }, 'no stock queries to refresh');
  }
  const result = await buildStockLayer(libraryDeps(deps), data, {
    queries,
    themes: profile?.imageThemes ?? [],
  });
  await embedMissing({ db: deps.db, providers: deps }, data);
  deps.logger.info({ businessId: data.businessId, ...result }, 'image library refreshed');
}

export async function onRefreshImageLibraryFailed(
  data: LibraryRefreshJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  deps.logger.error({ businessId: data.businessId, reason }, 'image library refresh failed');
}
