import { describe, expect, it } from 'vitest';
import { parseFailure } from '../../client/failure-reasons';
import { redactFailureReason } from '../api/failure-presenter';
import { scanWarnings } from './warnings';

const none = { errors: [], notConfigured: false };

describe('scanWarnings', () => {
  it('says nothing when the scan went well', () => {
    expect(scanWarnings({ crawlErrors: [], imageErrors: [], stock: none })).toEqual([]);
  });

  it('turns many raw lines into one coded line per kind, with no raw text', () => {
    const lines = scanWarnings({
      crawlErrors: ['https://x.example/a: HTTP 500', 'sitemap https://x.example/s.xml: timeout'],
      imageErrors: ['https://x.example/1.jpg: ECONNREFUSED 10.0.0.5', 'https://x.example/2.jpg: x'],
      stock: { errors: ['pexels "bread": 429'], notConfigured: false },
    });
    expect(lines).toEqual(['scan_pages_skipped: 2', 'scan_images_skipped: 2', 'stock_unavailable']);
    expect(lines.join('\n')).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|pexels|HTTP 500/);
  });

  it('names a missing stock provider apart from a transient stock failure', () => {
    const lines = scanWarnings({
      crawlErrors: [],
      imageErrors: [],
      stock: {
        errors: ['No stock image provider configured (PEXELS_API_KEY)'],
        notConfigured: true,
      },
    });
    expect(lines).toEqual(['stock_not_configured']);
  });

  it('every line parses to a known code and survives the customer redaction', () => {
    const lines = scanWarnings({
      crawlErrors: ['a'],
      imageErrors: ['b', 'c', 'd'],
      stock: { errors: ['e'], notConfigured: false },
    });
    for (const line of lines) {
      expect(parseFailure(line)).not.toBeNull();
      expect(redactFailureReason(line)).toBe(line);
    }
    expect(parseFailure('scan_images_skipped: 3')?.params.count).toBe(3);
  });
});
