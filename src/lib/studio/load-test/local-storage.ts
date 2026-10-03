import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, normalize, sep } from 'node:path';
import type { AssetStorage } from '../storage';

// 20.29 load-test harness — object storage on local disk, served over HTTP on 127.0.0.1 so the
// real FFmpeg checks (probe, blackdetect, loudness, mastering, thumbnails) read "signed URLs" the
// way they read R2 in production. Never used outside the harness (load-test/guard.ts).

export interface LocalStorage {
  storage: AssetStorage;
  /** http://127.0.0.1:<port> */
  baseUrl: string;
  /** Bytes written so far (all objects). */
  bytesWritten(): number;
  close(): Promise<void>;
}

/** Resolve bucket/key under root, refusing anything that escapes it. */
export function objectPath(root: string, bucket: string, key: string): string {
  const full = normalize(join(root, bucket, key));
  if (!full.startsWith(normalize(root) + sep)) throw new Error(`object path escapes root: ${key}`);
  return full;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  json: 'application/json',
};

export function contentTypeOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Serves GET/HEAD (with single Range requests, which FFmpeg uses) for files under root. */
function serve(root: string): Server {
  return createServer((req, res) => {
    void (async () => {
      const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/').replace(/^\/+/, '');
      const [bucket, ...rest] = path.split('/');
      let file: string;
      try {
        file = objectPath(root, bucket ?? '', rest.join('/'));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) {
        res.writeHead(404).end();
        return;
      }
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      const start = range?.[1] ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      const headers = {
        'content-type': contentTypeOf(file),
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        ...(range && { 'content-range': `bytes ${start}-${end}/${info.size}` }),
      };
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(file, { start, end }).pipe(res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}

export async function createLocalStorage(root: string): Promise<LocalStorage> {
  await mkdir(root, { recursive: true });
  const server = serve(root);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const urlOf = (bucket: string, key: string) =>
    `${baseUrl}/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  let written = 0;
  const write = async (bucket: string, key: string, body: Uint8Array) => {
    const file = objectPath(root, bucket, key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
    written += body.byteLength;
  };
  const storage: AssetStorage = {
    async put({ bucket, key, body }) {
      await write(bucket, key, body);
      return { bucket, key, url: urlOf(bucket, key) };
    },
    async signedUrl(bucket, key) {
      return urlOf(bucket, key);
    },
    async size(bucket, key) {
      return (await stat(objectPath(root, bucket, key))).size;
    },
    async readRange(bucket, key, start, endInclusive) {
      const all = await readFile(objectPath(root, bucket, key));
      return new Uint8Array(all.subarray(start, endInclusive + 1));
    },
    async delete(bucket, key) {
      await rm(objectPath(root, bucket, key), { force: true });
    },
    async putStream({ bucket, key, body }) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      const all = Buffer.concat(chunks);
      await write(bucket, key, all);
      return { bucket, key, bytes: all.byteLength };
    },
    async copy(bucket, fromKey, toKey) {
      await write(bucket, toKey, await readFile(objectPath(root, bucket, fromKey)));
    },
  };
  return {
    storage,
    baseUrl,
    bytesWritten: () => written,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
