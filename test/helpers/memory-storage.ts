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
  };
  return { storage, objects };
}
