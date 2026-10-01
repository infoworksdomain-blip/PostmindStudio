// Offline stand-in for object storage (QA specs under e2e/qa). The app is pointed at it with
// AWS_ENDPOINT_URL_S3=http://127.0.0.1:3199 so HEAD (size check before publishing) and GET (video
// preview / download) never reach a real bucket. Not a general S3: any path answers a 1 MiB file.
import { createServer } from 'node:http';

const port = Number(process.env.S3_STUB_PORT ?? 3199);
const body = Buffer.alloc(1_048_576);

createServer((req, res) => {
  res.writeHead(200, {
    'content-type': 'video/mp4',
    'content-length': String(body.length),
    'accept-ranges': 'bytes',
    etag: '"qa-stub"',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}).listen(port, '127.0.0.1', () => process.stdout.write(`s3 stub on ${port}\n`));
