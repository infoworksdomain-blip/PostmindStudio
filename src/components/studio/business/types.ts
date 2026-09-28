// Response shapes for the business screens (services/scans.ts, services/image-library.ts,
// prisma BusinessProfile / WebsiteScan / ImageLibraryItem), as the browser sees them.

export interface BusinessProfile {
  id: string;
  businessId: string;
  industry: string;
  subNiche: string;
  products: string[];
  services: string[];
  audienceKeywords: string[];
  toneIndicators: string[];
  regions: string[];
  imageThemes: string[];
  imageSearchQueries: string[];
  restrictedTopics: string[];
  brandVoiceSummary: string | null;
  classifierModel: string;
  lastRefreshedAt: string;
  editedByUser: boolean;
  /** 15.D8 / A13: the classifier's self-reported confidence (0–1; null before 15.D8). */
  classifierConfidence?: number | null;
  /** 15.D8 / A13: low-confidence classification the user has not yet confirmed or edited. */
  needsReview?: boolean;
}

export type ProfileListField =
  | 'products'
  | 'services'
  | 'audienceKeywords'
  | 'toneIndicators'
  | 'regions'
  | 'imageThemes'
  | 'imageSearchQueries'
  | 'restrictedTopics';

export type ScanState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface WebsiteScan {
  id: string;
  businessId: string;
  url: string;
  state: ScanState;
  pagesCrawled: number;
  imagesIngested: number;
  errorReason: string | null;
  robotsBlocked: boolean;
  usedJsRender: boolean;
  costPence: number;
  startedAt: string;
  completedAt: string | null;
  /** 15.D8 / A11.2: the ownership checkbox text the user ticked (null: historic / scheduled). */
  ownershipStatement?: string | null;
}

/** GET /scans/:id adds the error lines and the library size per source. */
export interface ScanDetail extends WebsiteScan {
  errors: string[];
  library: Partial<Record<ImageSource, number>>;
}

export type ImageSource = 'SCRAPED' | 'STOCK' | 'GENERATED' | 'UPLOAD';

export interface LibraryImage {
  id: string;
  businessId: string;
  source: ImageSource;
  sourceUrl: string | null;
  sourceProvider: string | null;
  publicUrl: string | null;
  previewUrl: string | null;
  hotlinked: boolean;
  widthPx: number;
  heightPx: number;
  fileSizeBytes: number;
  tags: string[];
  altText: string | null;
  generatedFromPrompt: string | null;
  licenseNotes: string | null;
  useCount: number;
  createdAt: string;
  /** Present on semantic search results. */
  similarity?: number;
}

export const ACTIVE_SCAN_STATES: ReadonlySet<ScanState> = new Set(['QUEUED', 'RUNNING']);

/** Comma/newline separated text → trimmed, de-duplicated list. */
export function parseList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}
