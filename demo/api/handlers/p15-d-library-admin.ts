// 15.D7 — staff corpus admin sample handlers, mirroring src/lib/studio/services/library-admin.ts:
//   GET  /admin/library/videos        every row with its licence status (incl. unlicensed/retired)
//   POST /admin/library/videos/bulk   accept / override / reject categorisation (≤100 ids)
//   POST /admin/library/reanalyse     queue re-analysis (202)
//   GET  /admin/library/licence-audit counts by scenario, missing / expired / expiring
// The demo corpus is fully licensed (every row has a licence), so the audit reports no missing
// rows; the filters and badges still work for the other states.
import { DemoHttpError, route } from '../registry';
import { present } from './library';
import { allLibraryItems, anyItem, patchItem } from './library-store';
import type { LibraryItem } from './library-data';

type Review = 'ACCEPTED' | 'OVERRIDDEN' | 'REJECTED';
const reviews = new Map<string, { review: Review; at: string }>();
const reanalysed = new Map<string, string>();
const UNLICENSED = new Set<string>();
const MAX_IDS = 100;

const licenceOf = (item: LibraryItem) =>
  UNLICENSED.has(item.id)
    ? { status: 'missing', scenario: null, licenseExpires: null, licenseSource: null }
    : {
        status: 'ok',
        scenario: item.scenario,
        licenseExpires: null,
        licenseSource: item.licenseSource,
      };

function adminRow(item: LibraryItem) {
  const review = reviews.get(item.id);
  return {
    ...present(item),
    ingestedAt: item.ingestedAt,
    retiredAt: item.retiredAt,
    reanalysedAt: reanalysed.get(item.id) ?? null,
    categoryReview: review?.review ?? null,
    categoryReviewedAt: review?.at ?? null,
    licence: licenceOf(item),
  };
}

route('GET', '/admin/library/videos', ({ query }) => {
  const licence = query.get('licence') ?? '';
  const retired = query.get('retired');
  const review = query.get('review') ?? '';
  const category = query.get('category')?.trim() ?? '';
  const q = query.get('q')?.trim().toLowerCase() ?? '';
  const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 25) || 25));
  const rows = allLibraryItems()
    .filter((i) => (retired === 'true' ? i.retiredAt : retired === 'false' ? !i.retiredAt : true))
    .filter((i) =>
      !licence
        ? true
        : licence === 'missing'
          ? UNLICENSED.has(i.id)
          : !UNLICENSED.has(i.id) && i.scenario === licence,
    )
    .filter((i) =>
      !review
        ? true
        : review === 'unreviewed'
          ? !reviews.has(i.id)
          : reviews.get(i.id)?.review === review,
    )
    .filter((i) => !category || i.categorySlug.startsWith(category))
    .filter((i) => !q || i.title.toLowerCase().includes(q))
    .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt));
  const cursor = query.get('cursor');
  const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
  const page = rows.slice(start, start + limit);
  return {
    data: page.map(adminRow),
    nextCursor: rows.length > start + limit ? (page.at(-1)?.id ?? null) : null,
  };
});

interface IdsBody {
  ids?: unknown;
  action?: string;
  categoryId?: string;
  category?: string;
}

function idsOf(body: IdsBody): string[] {
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > MAX_IDS)
    throw new DemoHttpError(400, 'validation_error', `ids must list 1–${MAX_IDS} items`);
  return [...new Set(body.ids.map(String))];
}

route('POST', '/admin/library/videos/bulk', ({ body }) => {
  const input = (body ?? {}) as IdsBody;
  const ids = idsOf(input);
  const action = input.action;
  if (action !== 'accept' && action !== 'override' && action !== 'reject')
    throw new DemoHttpError(400, 'validation_error', 'action must be accept, override or reject');
  const slug = input.category ?? input.categoryId?.replace(/^cat-/, '').replace(/-/g, '/');
  if (action === 'override' && !slug)
    throw new DemoHttpError(
      400,
      'validation_error',
      'override needs categoryId (or category slug)',
    );
  const found = ids.filter((id) => anyItem(id));
  if (found.length === 0)
    throw new DemoHttpError(404, 'not_found', 'None of these library videos exist');
  const at = new Date().toISOString();
  const review: Review =
    action === 'accept' ? 'ACCEPTED' : action === 'override' ? 'OVERRIDDEN' : 'REJECTED';
  let retired = 0;
  for (const id of found) {
    reviews.set(id, { review, at });
    if (action === 'override' && slug) patchItem(id, { categorySlug: slug });
    if (action === 'reject' && !anyItem(id)?.retiredAt) {
      patchItem(id, { retiredAt: at });
      retired += 1;
    }
  }
  return {
    action,
    updated: found,
    missing: ids.filter((id) => !found.includes(id)),
    retired,
    categoryId: action === 'override' && slug ? `cat-${slug.replace(/\//g, '-')}` : null,
  };
});

route('POST', '/admin/library/reanalyse', ({ body }) => {
  const ids = idsOf((body ?? {}) as IdsBody);
  const at = new Date().toISOString();
  const queued = ids.filter((id) => anyItem(id));
  for (const id of queued) reanalysed.set(id, at);
  return {
    status: 202,
    body: {
      queued: queued.map((id) => ({ id, jobId: `reanalyse-library-video__${id}__demo` })),
      skipped: ids.filter((id) => !queued.includes(id)).map((id) => ({ id, reason: 'unknown' })),
    },
  };
});

route('GET', '/admin/library/licence-audit', ({ query }) => {
  const limit = Math.min(200, Math.max(0, Number(query.get('limit') ?? 50) || 0));
  const live = allLibraryItems().filter((i) => !i.retiredAt);
  const byScenario: Record<string, number> = { LICENSED: 0, OWNED: 0, SCRAPED: 0, NOT_REQUIRED: 0 };
  for (const i of live)
    if (!UNLICENSED.has(i.id)) byScenario[i.scenario] = (byScenario[i.scenario] ?? 0) + 1;
  const missing = live.filter((i) => UNLICENSED.has(i.id));
  return {
    generatedAt: new Date().toISOString(),
    expiringWithinDays: 30,
    live: live.length,
    retired: allLibraryItems().length - live.length,
    byScenario,
    missing: missing.length,
    expired: 0,
    expiringSoon: 0,
    problems: missing
      .slice(0, limit)
      .map((i) => ({ id: i.id, title: i.title, problem: 'missing', licenseExpires: null })),
    problemsTruncated: missing.length > limit,
  };
});
