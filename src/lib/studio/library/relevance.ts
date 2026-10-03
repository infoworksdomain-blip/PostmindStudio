/**
 * Relevance floor for free-text library search (shared by the search service and the demo's
 * simulated search, so it has no server imports): an item below this cosine similarity is not a
 * result unless a query word also appears in its title or tags (keyword boost > 0). Without it a
 * query with no real match ("luxury cars" against a bakery-only library) returned the nearest
 * items anyway, labelled with a weak percentage. text-embedding-3-small puts unrelated short
 * texts around 0.05-0.2 and related ones above 0.3; 0.25 is the conservative cut, to be tuned on
 * the production corpus.
 */
export const MIN_SIMILARITY = 0.25;

/** True when an item with this similarity and keyword boost is relevant enough to be listed. */
export function isRelevant(similarity: number, boost: number): boolean {
  return similarity >= MIN_SIMILARITY || boost > 0;
}
