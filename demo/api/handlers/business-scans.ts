// Website scans (services/scans.ts + the scan-website worker): start a scan, watch it go
// QUEUED → RUNNING (pages read climbing) → SUCCEEDED over ~15 s, scan history, scan detail with
// the library size per source. A finished scan adds the images it found and refreshes the profile.
import type { ScanDetail, WebsiteScan } from '@/components/studio/business/types';
import { DEMO_BUSINESS_ID, DEMO_ORG_ID } from '../ids';
import { DemoHttpError, route } from '../registry';
import { SCAN_FINDS, SCAN_PAGES } from './business-images-seed';
import { addLibraryImages, librarySizeBySource } from './business-images';
import { refreshProfileFromScan } from './business-profile';

interface StoredScan extends WebsiteScan {
  organisationId: string;
  /** Live scans derive their progress from this; seeded scans are already settled. */
  live: boolean;
  settled: boolean;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const QUEUED_MS = 2_000;
const DONE_MS = 15_000;
const LOADED_AT = Date.now();
const at = (ms: number) => new Date(LOADED_AT + ms).toISOString();

const scans: StoredScan[] = [
  {
    id: 'scan-2',
    organisationId: DEMO_ORG_ID,
    businessId: DEMO_BUSINESS_ID,
    url: 'https://leedssourdough.co.uk/',
    state: 'SUCCEEDED',
    pagesCrawled: 18,
    imagesIngested: 12,
    errorReason: null,
    robotsBlocked: false,
    usedJsRender: false,
    costPence: 41,
    startedAt: at(-21 * DAY),
    completedAt: at(-21 * DAY + 3 * MIN + 40_000),
    live: false,
    settled: true,
  },
  {
    id: 'scan-1',
    organisationId: DEMO_ORG_ID,
    businessId: DEMO_BUSINESS_ID,
    url: 'https://www.leedssourdough.co.uk/',
    state: 'FAILED',
    pagesCrawled: 0,
    imagesIngested: 0,
    errorReason: 'The site did not answer within 20 seconds (https://www.leedssourdough.co.uk/)',
    robotsBlocked: false,
    usedJsRender: false,
    costPence: 0,
    startedAt: at(-23 * DAY),
    completedAt: at(-23 * DAY + MIN),
    live: false,
    settled: true,
  },
  {
    id: 'scan-0',
    organisationId: DEMO_ORG_ID,
    businessId: DEMO_BUSINESS_ID,
    url: 'https://leedssourdough.wixsite.com/bakery',
    state: 'SUCCEEDED',
    pagesCrawled: 7,
    imagesIngested: 5,
    errorReason:
      'Skipped /members: disallowed by robots.txt\nSkipped /checkout: disallowed by robots.txt',
    robotsBlocked: true,
    usedJsRender: true,
    costPence: 29,
    startedAt: at(-74 * DAY),
    completedAt: at(-74 * DAY + 4 * MIN),
    live: false,
    settled: true,
  },
];

/** Where a live scan is now, from its start time; settles once (images + profile). */
function current(scan: StoredScan): StoredScan {
  if (!scan.live) return scan;
  const elapsed = Date.now() - Date.parse(scan.startedAt);
  if (elapsed < QUEUED_MS) return { ...scan, state: 'QUEUED' };
  if (elapsed < DONE_MS) {
    const share = (elapsed - QUEUED_MS) / (DONE_MS - QUEUED_MS);
    const pages = Math.min(SCAN_PAGES.length, 1 + Math.floor(share * SCAN_PAGES.length));
    return {
      ...scan,
      state: 'RUNNING',
      pagesCrawled: pages,
      imagesIngested: Math.floor(pages * 1.4),
    };
  }
  if (!scan.settled) {
    const completedAt = new Date(Date.parse(scan.startedAt) + DONE_MS).toISOString();
    addLibraryImages(SCAN_FINDS);
    refreshProfileFromScan(scan.businessId, completedAt);
    Object.assign(scan, {
      state: 'SUCCEEDED',
      pagesCrawled: SCAN_PAGES.length,
      imagesIngested: 15,
      costPence: 38,
      completedAt,
      settled: true,
      live: false,
    } satisfies Partial<StoredScan>);
  }
  return scan;
}

function publicScan(s: StoredScan): WebsiteScan {
  const { organisationId: _o, live: _l, settled: _s, ...rest } = current(s);
  void _o;
  void _l;
  void _s;
  return rest;
}

const newestFirst = (a: StoredScan, b: StoredScan) => b.startedAt.localeCompare(a.startedAt);

route('GET', '/businesses/:id/scans', ({ params }) => ({
  data: scans
    .filter((s) => s.businessId === params.id)
    .sort(newestFirst)
    .slice(0, 20)
    .map(publicScan),
}));

route('GET', '/scans/:id', ({ params }) => {
  const scan = scans.find((s) => s.id === params.id);
  if (!scan) throw new DemoHttpError(404, 'not_found', 'Scan not found');
  const pub = publicScan(scan);
  const detail: ScanDetail = {
    ...pub,
    errors: pub.errorReason ? pub.errorReason.split('\n') : [],
    library: librarySizeBySource(pub.businessId),
  };
  return { scan: detail };
});

function normaliseUrl(raw: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new DemoHttpError(400, 'validation_error', 'url is not a valid web address');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new DemoHttpError(400, 'validation_error', 'Only http and https URLs can be fetched');
  url.hash = '';
  return url.toString();
}

route('POST', '/businesses/:id/scan-website', ({ params, body }) => {
  const businessId = params.id ?? '';
  const input = (body ?? {}) as { url?: unknown; ownershipConfirmed?: unknown };
  if (input.ownershipConfirmed !== true) {
    throw new DemoHttpError(400, 'validation_error', 'Invalid request body', {
      problems: ['ownershipConfirmed must be true: confirm you own or represent this website'],
    });
  }
  if (typeof input.url !== 'string' || !input.url.trim())
    throw new DemoHttpError(400, 'validation_error', 'Invalid request body', {
      problems: ['url: Too small'],
    });
  const running = scans.find(
    (s) => s.businessId === businessId && ['QUEUED', 'RUNNING'].includes(current(s).state),
  );
  if (running)
    throw new DemoHttpError(409, 'conflict', 'A scan for this business is already in progress', {
      scanId: running.id,
    });
  const scan: StoredScan = {
    id: `scan-${Date.now().toString(36)}`,
    organisationId: DEMO_ORG_ID,
    businessId,
    url: normaliseUrl(input.url.trim()),
    state: 'QUEUED',
    pagesCrawled: 0,
    imagesIngested: 0,
    errorReason: null,
    robotsBlocked: false,
    usedJsRender: false,
    costPence: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    live: true,
    settled: false,
  };
  scans.push(scan);
  // Settle even if nobody is watching (the library and profile update either way).
  setTimeout(() => current(scan), DONE_MS + 100);
  return { status: 202, body: { scanId: scan.id, scan: publicScan(scan) } };
});
