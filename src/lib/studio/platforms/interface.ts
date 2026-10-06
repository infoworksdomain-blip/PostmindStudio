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
  /** OAuth scopes the connection granted (Studio OAuth platforms); absent = unknown (Meta). */
  grantedScopes?: string[];
  /** 22.7: the TikTok connection's posting preference; absent = direct (other platforms ignore it). */
  tiktokPostMode?: 'direct' | 'drafts';
  /** 15.A3: custom thumbnail set after upload (YouTube thumbnails.set). */
  thumbnail?: { bytes: Uint8Array; contentType: 'image/jpeg' | 'image/png' };
  /** 15.A4: caption track uploaded after the video (YouTube captions.insert). */
  captions?: { srt: string; language: string; name: string };
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

/** 21.6: one rendered carousel slide (1080×1350), as JPEG (Instagram, TikTok) or PNG. */
export interface CarouselSlideSource {
  /** Time-limited URL of the JPEG (platforms that pull by URL). */
  jpegUrl: string;
  /** The JPEG's bytes (platforms that take an upload, e.g. LinkedIn). */
  readJpeg(): Promise<Uint8Array>;
  width: number;
  height: number;
  /** Alt text: the slide's words. */
  altText: string;
}

/** 21.6: a carousel (post-card images) publish; same copy and credentials as a video. */
export interface CarouselPublishRequest extends Omit<
  PublishRequest,
  'video' | 'thumbnail' | 'captions' | 'aiGenerated'
> {
  slides: CarouselSlideSource[];
  /** True when any slide's picture was AI-generated (the platform's AI label is then set). */
  aiGenerated: boolean;
}

export interface PlatformPublisher {
  readonly platform: Platform;
  publish(request: PublishRequest): Promise<PublishResult>;
  /** 21.6: publish a carousel of images; absent = the platform takes no carousels from Studio. */
  publishCarousel?(request: CarouselPublishRequest): Promise<PublishResult>;
  /** Delete the post where the platform documents a delete API; absent = not supported. */
  takedown?(request: TakedownRequest): Promise<void>;
}

export interface PublisherDeps {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}
