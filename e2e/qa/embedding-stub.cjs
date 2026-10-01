'use strict';

// QA stub for the paid embedding API (OpenAI text-embedding-3-large, 1536 dimensions).
//
// Preload it into the app process so library search and "Picked for your business" never call a
// paid API:   QA_EMBEDDING_STUB=1 NODE_OPTIONS="--require ./e2e/qa/embedding-stub.cjs" OPENAI_API_KEY=stub npm start
// Only POST https://api.openai.com/v1/embeddings is answered here; every other request goes to the
// real fetch untouched. The vectors are deterministic bags of words (embed()), so the specs seed
// library rows with the same function and know which reference a query must rank first.

const DIMENSIONS = 1536;

/** FNV-1a, 32 bit. */
function hash(word) {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i += 1) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Unit-length bag of words: each distinct lower-case word lights one dimension. */
function embed(text) {
  const vector = new Array(DIMENSIONS).fill(0);
  const words =
    String(text)
      .toLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  for (const word of new Set(words)) vector[hash(word) % DIMENSIONS] += 1;
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
  return vector.map((x) => x / norm);
}

function install() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function stubbedFetch(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.openai.com/v1/embeddings')) return realFetch(input, init);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    const texts = Array.isArray(body.input) ? body.input : [body.input];
    const data = texts.map((text, index) => ({
      object: 'embedding',
      index,
      embedding: embed(text),
    }));
    return new Response(
      JSON.stringify({
        object: 'list',
        data,
        model: body.model ?? 'text-embedding-3-large',
        usage: { prompt_tokens: texts.length, total_tokens: texts.length },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

if (process.env.QA_EMBEDDING_STUB === '1' && typeof globalThis.fetch === 'function') install();

module.exports = { embed, DIMENSIONS };
