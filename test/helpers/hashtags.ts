// 20.13: a person's POST /publications needs at least five hashtags (with the business hashtag,
// when the business has one). Tests that are not about hashtags send these as well as their own.

export const TEST_HASHTAGS = ['LeedsBakery', 'Sourdough', 'RealBread', 'BakeryLife', 'ShopLocal'];

/** The body with its own hashtags first, then the test set, de-duplicated (at most five). */
export function withHashtags<T>(body: T, count = 5): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const own = Array.isArray(record.hashtags) ? (record.hashtags as string[]) : [];
  const seen = new Set<string>();
  const hashtags = [...own, ...TEST_HASHTAGS].filter((tag) => {
    const key = tag.replace(/^#+/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...record, hashtags: own.length >= count ? own : hashtags.slice(0, count) } as T;
}
