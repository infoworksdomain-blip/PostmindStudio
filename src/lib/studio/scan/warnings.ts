// What a finished scan tells the customer about the things it could not do. The worker used to
// store every raw line (`https://site/img.jpg: connect ECONNREFUSED …`, `pexels "bread": …`,
// `No stock image provider configured (PEXELS_API_KEY …)`), which a customer saw as a wall of
// identical "Something went wrong" lines. Now each kind becomes ONE coded line the UI translates
// (failures.codes.*, src/lib/client/failure-reasons.ts); the raw text goes to the worker log.

export interface ScanWarningInput {
  /** Pages, the sitemap or the JS renderer that failed while crawling. */
  crawlErrors: readonly string[];
  /** Site images that could not be downloaded or stored. */
  imageErrors: readonly string[];
  stock: {
    errors: readonly string[];
    /** No stock photo provider is set up at all (an operator setting, not a transient failure). */
    notConfigured: boolean;
  };
}

/** One coded line per kind of problem, in the order a person reads them; none when all went well. */
export function scanWarnings(input: ScanWarningInput): string[] {
  const lines: string[] = [];
  if (input.crawlErrors.length > 0) lines.push(`scan_pages_skipped: ${input.crawlErrors.length}`);
  if (input.imageErrors.length > 0) lines.push(`scan_images_skipped: ${input.imageErrors.length}`);
  if (input.stock.notConfigured) lines.push('stock_not_configured');
  else if (input.stock.errors.length > 0) lines.push('stock_unavailable');
  return lines;
}
