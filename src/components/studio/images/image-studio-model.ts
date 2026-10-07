import type { LibraryImage } from '../business/types';

// BACKLOG 25.8 — Image Studio's pure parts. The form sends exactly what POST /image-library/generate
// accepts (services/image-library.ts generateImageInput): a prompt (3–1000 characters), an optional
// style (up to 200) and one of four shapes. A generated image keeps what it was made from:
// `altText` is the prompt as typed (first 500 characters) and `generatedFromPrompt` the full text
// sent to the provider, whose "Style: …" line is the style (images/library.ts generateLibraryImage).

export const IMAGE_ASPECTS = ['1:1', '4:5', '9:16', '16:9'] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];

export const PROMPT_MIN = 3;
export const PROMPT_MAX = 1_000;
export const STYLE_MAX = 200;

export interface ImageRequest {
  prompt: string;
  style: string;
  aspectRatio: ImageAspect;
}

/** The request body for POST /image-library/generate (style left out when empty). */
export function generateBody(businessId: string, request: ImageRequest) {
  const style = request.style.trim();
  return {
    businessId,
    prompt: request.prompt.trim(),
    ...(style && { style }),
    aspectRatio: request.aspectRatio,
  };
}

export function isValidRequest(request: Pick<ImageRequest, 'prompt' | 'style'>): boolean {
  const prompt = request.prompt.trim();
  return (
    prompt.length >= PROMPT_MIN &&
    prompt.length <= PROMPT_MAX &&
    request.style.trim().length <= STYLE_MAX
  );
}

/** The listed shape closest to an image's width ÷ height. */
export function nearestAspect(widthPx: number, heightPx: number): ImageAspect {
  if (!(widthPx > 0) || !(heightPx > 0)) return '1:1';
  const ratio = widthPx / heightPx;
  const value = (a: ImageAspect) => {
    const [w, h] = a.split(':').map(Number) as [number, number];
    return w / h;
  };
  return IMAGE_ASPECTS.reduce((best, a) =>
    Math.abs(Math.log(value(a) / ratio)) < Math.abs(Math.log(value(best) / ratio)) ? a : best,
  );
}

const STYLE_LINE = /^Style:\s*(.+)$/m;

/** What a generated image was made from, to show it and to make it again; null if not generated. */
export function requestOf(image: LibraryImage): ImageRequest | null {
  if (image.source !== 'GENERATED') return null;
  const full = image.generatedFromPrompt ?? '';
  const prompt = (image.altText ?? full.split('\n')[0] ?? '').trim();
  if (prompt.length < PROMPT_MIN) return null;
  const style = STYLE_LINE.exec(full)?.[1]?.trim() ?? '';
  return {
    prompt: prompt.slice(0, PROMPT_MAX),
    style: style.slice(0, STYLE_MAX),
    aspectRatio: nearestAspect(image.widthPx, image.heightPx),
  };
}
