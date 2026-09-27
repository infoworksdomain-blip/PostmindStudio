// Response shapes of /api/studio as the browser sees them (dates are ISO strings; BigInts are
// strings). Kept by hand — the UI never imports server modules. Area-specific types live next to
// their screens' components.

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface TargetFormat {
  platform: string;
  aspectRatio: '9:16' | '16:9' | '1:1' | '4:5';
  duration: number;
}

export interface Project {
  id: string;
  organisationId: string;
  businessId: string;
  name: string;
  description: string | null;
  state: string;
  sourceType:
    'BRIEF' | 'POSTMIND_CONTENT' | 'SLIDESHOW' | 'LIBRARY_REFERENCE' | 'TEMPLATE' | 'UPLOAD';
  referenceVideoId: string | null;
  referenceMode: 'TEMPLATE' | 'INSPIRE' | null;
  targetFormats: TargetFormat[];
  brandKitId: string | null;
  costBudgetPence: number | null;
  costActualPence: number;
  reviewPolicy: string;
  publishPolicy: string;
  errorReason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ShotSummary {
  id: string;
  sortOrder: number;
  durationSec: number;
  visualTreatment: string;
  state: string;
  errorReason: string | null;
}

export interface Shot extends ShotSummary {
  scriptId: string;
  sceneDescription: string;
  cameraDirection: string | null;
  voiceoverText: string | null;
  onScreenText: string | null;
  transitionOut: string | null;
  assetId: string | null;
  voiceAssetId: string | null;
}

export interface Script {
  id: string;
  projectId: string;
  targetPlatform: string;
  targetAspectRatio: string;
  targetDurationSec: number;
  fullText: string;
  scriptModel: string;
  shots: Shot[];
}

export interface QualityIssue {
  code: string;
  status: 'passed' | 'failed' | 'warning' | 'skipped';
  severity: string;
  detail: string;
}

export interface Render {
  id: string;
  projectId: string;
  scriptId: string;
  targetPlatform: string;
  aspectRatio: string;
  resolution: string;
  durationSec: number;
  qualityCheckState: 'PENDING' | 'PASSED' | 'FAILED' | 'FORCE_APPROVED';
  qualityIssues: QualityIssue[] | null;
  costPence: number;
  createdAt: string;
}

export interface Publication {
  id: string;
  projectId: string;
  renderId: string;
  platform: string;
  platformAccountId: string;
  state: string;
  scheduledFor: string | null;
  publishedAt: string | null;
  platformPostId: string | null;
  platformUrl: string | null;
  caption: string | null;
  hashtags: string[];
  errorReason: string | null;
  errorCode: string | null;
  retryCount: number;
  createdAt: string;
  project?: { id: string; name: string };
}

export interface ProjectDetail extends Project {
  brief: { hook: string; keyMessage: string; targetAudience: string; tone: string } | null;
  scripts: Array<Omit<Script, 'shots'> & { shots: ShotSummary[] }>;
  renders: Render[];
  publications: Publication[];
  approvals: Array<{ id: string; state: string; note: string | null; createdAt: string }>;
}

export interface PlatformConnection {
  id: string;
  businessId: string;
  platform: 'tiktok' | 'youtube' | 'x' | 'linkedin';
  platformAccountId: string;
  platformAccountName: string;
  accessTokenExpiresAt: string | null;
  scopes: string[];
  state: 'active' | 'needs_reconnect' | 'revoked';
  connectedAt: string;
}

export interface BrandKit {
  id: string;
  businessId: string;
  name: string;
  isDefault: boolean;
  colourPalette: string[];
  fontPrimary: string | null;
  fontSecondary: string | null;
  toneKeywords: string[];
  audienceProfile: string | null;
  ctaTemplates: Array<{ label: string; template: string }>;
  restrictedTopics: string[];
}
