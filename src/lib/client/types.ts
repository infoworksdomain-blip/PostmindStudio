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
  /** 17.9: null when the user gave no name (show useProjectName's translated fallback). */
  name: string | null;
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
  /** `not_run`: the check did not apply or could not run (e.g. 20.21 content safety). */
  status: 'passed' | 'failed' | 'warning' | 'skipped' | 'not_run';
  severity: string;
  /** English (older checks have only this). */
  detail: string;
  /** 17.9: review.quality.details.<detailKey> with detailParams, in the reader's language. */
  detailKey?: string;
  detailParams?: Record<string, string | number>;
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
  project?: { id: string; name: string | null };
  /** 15.A8: latest cumulative metrics snapshot (list endpoint only). */
  latestMetrics?: { views: number; likes: number; comments: number; at: string } | null;
  /** Per-platform extras (15.A2 tiktokMode "inbox" + note; 15.A9 captionTruncated). */
  metadata?: Record<string, unknown> | null;
}

export interface ProjectDetail extends Project {
  /** 20.18: directions ideation suggested while the brief is too vague (empty otherwise). */
  directionOptions?: string[];
  /** 20.18 (spec 13.3): restricted topics awaiting the owner's confirmation (empty otherwise). */
  pendingRestrictedTopics?: string[];
  brief: { hook: string; keyMessage: string; targetAudience: string; tone: string } | null;
  scripts: Array<Omit<Script, 'shots'> & { shots: ShotSummary[] }>;
  renders: Render[];
  publications: Publication[];
  approvals: Array<{
    id: string;
    state: string;
    note: string | null;
    createdAt: string;
    /** "system:auto-approve" for automatic approvals (automation/approval.ts). */
    resolvedByUserId?: string | null;
  }>;
}

export interface PlatformConnection {
  id: string;
  /** null: an organisation-wide Meta channel registered by PostMind Core. */
  businessId: string | null;
  platform: 'tiktok' | 'youtube' | 'x' | 'linkedin' | 'instagram' | 'facebook';
  platformAccountId: string;
  platformAccountName: string;
  accessTokenExpiresAt: string | null;
  scopes: string[];
  state: 'active' | 'needs_reconnect' | 'revoked';
  connectedAt: string;
  /** 17.3: when the daily account-status check last ran, and what it found. */
  statusCheckedAt?: string | null;
  statusCheckOutcome?: 'ok' | 'needs_reconnect' | 'unreachable' | null;
  /** Phase 18: 'core' (PostMind pushed it), 'studio' (Studio's own OAuth), null (pre-Phase 18). */
  connectedVia?: 'core' | 'studio' | null;
}

/** Phase 18 §2.10: how Instagram / Facebook are connected (GET /platform-connections `meta`). */
export interface MetaConnectInfo {
  connect: 'studio' | 'core';
  /** false while the operator has not configured Studio's Meta app. */
  configured: boolean;
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
  /** 13.13: the kit's cloned narration voice (null/absent = stock voice). */
  voiceProfileId?: string | null;
  /** 15.B1: ids of READY brand uploads (logo, watermark, intro/outro cards). */
  logoAssetId?: string | null;
  watermarkAssetId?: string | null;
  introCardAssetId?: string | null;
  outroCardAssetId?: string | null;
  /** Operator decision P6: optional on-video "AI-generated" label. */
  aiDisclosureLabel?: boolean;
}

/** P1 BYOC: GET /provider-credentials (never key material; `hint` is the last 4 characters). */
export interface ByocProviderOption {
  id: string;
  label: string;
  /** Needs a public + private key pair (Storyblocks). */
  twoPart: boolean;
}

export interface ProviderCredential {
  providerId: string;
  hint: string | null;
  state: 'active' | 'revoked';
  lastTestedAt: string | null;
  lastTestResult: { healthy: boolean; reason?: string } | null;
  updatedAt: string;
}

export interface ProviderCredentialsResponse {
  enabled: boolean;
  reason?: 'disabled' | 'plan_tier';
  providers: ByocProviderOption[];
  credentials: ProviderCredential[];
}
