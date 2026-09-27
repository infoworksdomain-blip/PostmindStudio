import type { AssetStorage } from '../../src/lib/studio/storage';

export function memoryStorage() {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const storage: AssetStorage = {
    async put({ bucket, key, body, contentType }) {
      objects.set(`${bucket}/${key}`, { body, contentType });
      return { bucket, key, url: `https://signed.example/${bucket}/${key}` };
    },
    async signedUrl(bucket, key) {
      return `https://signed.example/${bucket}/${key}`;
    },
    async size(bucket, key) {
      const object = objects.get(`${bucket}/${key}`);
      if (!object) throw new Error(`missing ${bucket}/${key}`);
      return object.body.byteLength;
    },
    async readRange(bucket, key, start, endInclusive) {
      const object = objects.get(`${bucket}/${key}`);
      if (!object) throw new Error(`missing ${bucket}/${key}`);
      return object.body.slice(start, endInclusive + 1);
    },
    async delete(bucket, key) {
      objects.delete(`${bucket}/${key}`);
    },
    async putStream({ bucket, key, body, contentType }) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.byteLength;
      }
      objects.set(`${bucket}/${key}`, { body: all, contentType });
      return { bucket, key, bytes: all.byteLength };
    },
    async copy(bucket, fromKey, toKey) {
      const object = objects.get(`${bucket}/${fromKey}`);
      if (!object) throw new Error(`missing ${bucket}/${fromKey}`);
      objects.set(`${bucket}/${toKey}`, object);
    },
  };
  return { storage, objects };
}
