import type { AspectRatio } from '../providers/interface';
import type { Platform } from '../services/catalog';

// BACKLOG 5.1 — PlatformPublisher contract. A publisher takes a finished render and does the
// platform's whole publish flow (register/init → upload → finalise/publish → status) inside one
// call, returning the platform's post id. Each platform's steps are in spec 9.2–9.7; the exact
// endpoints come from the platforms' current docs (read 2026-09-27) and are cited per file.

/** Bytes of the render, read lazily in chunks from Studio storage. */
export interface VideoSource {
  sizeBytes: number;
  contentType: 'video/mp4';
  durationSec: number;
  aspectRatio: AspectRatio;
  /** A time-limited URL platforms can fetch (Meta pulls by URL). */
  signedUrl: string;
  read(start: number, endInclusive: number): Promise<Uint8Array>;
}

export interface PublishRequest {
  video: VideoSource;
  /** Final platform text (already formatted and length-checked by captions.ts). */
  text: string;
  /** The caption and hashtags separately, for platforms that mark hashtags up (LinkedIn). */
  caption: string;
  hashtags: string[];
  /** Short title where the platform has one (YouTube). */
  title?: string;
  accessToken: string;
  /** The platform account (open_id, channel id, IG user id, page id, member URN…). */
  accountId: string;
  /** Studio videos are AI-generated; publishers set the platform's AI-content label if it has one. */
  aiGenerated: true;
  options?: Record<string, unknown>;
}

export interface PublishResult {
  platformPostId: string;
  /** Public URL when the platform documents one; null otherwise (never guessed). */
  platformUrl: string | null;
  metadata: Record<string, unknown>;
}

export interface TakedownRequest {
  accessToken: string;
  accountId: string;
  platformPostId: string;
}

export interface PlatformPublisher {
  readonly platform: Platform;
  publish(request: PublishRequest): Promise<PublishResult>;
  /** Delete the post where the platform documents a delete API; absent = not supported. */
  takedown?(request: TakedownRequest): Promise<void>;
}

export interface PublisherDeps {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}
