// Response shapes of /api/studio/library/* (src/lib/studio/services/library.ts), as the browser
// sees them. Kept by hand — the UI never imports server modules.

export type ReferenceMode = 'TEMPLATE' | 'INSPIRE';

export interface LibraryVideoSummary {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  durationSec: number;
  aspectRatio: string;
  sourcePlatform: string | null;
  category: { slug: string; name: string };
  analysis: {
    paceTag: string;
    moodTag: string;
    structurePattern: string;
    shotCount: number;
  } | null;
  allowedModes: string[];
  thumbnailUrl: string;
  /** Present on similar / recommended results (cosine similarity 0–1). */
  similarity?: number;
}

export interface LibraryVideoDetail {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  durationSec: number;
  aspectRatio: string;
  sourcePlatform: string | null;
  ingestedAt: string;
  category: { slug: string; name: string };
  analysis: {
    shotCount: number;
    hookPattern: string;
    structurePattern: string;
    ctaPattern: string | null;
    paceTag: string;
    moodTag: string;
  } | null;
  allowedModes: string[];
  thumbnailUrl: string;
  previewUrl: string;
  previewExpiresInSec: number;
}

export interface BlueprintShot {
  durationSec: number;
  type: string;
  overlayStyle: string;
  voiceoverPresent: boolean;
  hasOnScreenText: boolean;
}

export interface Blueprint {
  shotCount: number;
  totalDurationSec: number;
  shots: BlueprintShot[];
  musicEnvelope: { bpm: number | null; energy: string | null; moodTag: string | null };
  transitionSequence: string[];
  hookPattern: string;
  structurePattern: string;
  ctaPattern: string | null;
  paceTag: string;
}

export interface BlueprintResponse {
  ok: true;
  libraryVideoId: string;
  allowedModes: string[];
  blueprint: Blueprint | null;
  styleSignature: {
    paceTag: string;
    moodTag: string;
    structurePattern: string;
    musicGenreTag: string | null;
  };
}

export interface CategoryNode {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  depth: number;
  children: CategoryNode[];
}

export interface ListResponse<T> {
  ok: true;
  data: T[];
  nextCursor?: string | null;
}
