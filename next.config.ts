import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { deploymentId } from './src/lib/deployment-id';

// Studio is used mostly as an API server (same pattern as the Engagement service).
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Version-skew protection: when a tab built from an older deploy talks to a newer server, Next.js
  // does a full reload instead of a client-side navigation
  // (https://nextjs.org/docs/app/guides/self-hosting#version-skew, read 2026-10-03). The image
  // build sets it to the commit SHA (Dockerfile ARG); unset locally and in tests.
  deploymentId: deploymentId(process.env.STUDIO_DEPLOYMENT_ID),
  // Server-only packages are loaded at runtime in Node rather than bundled.
  serverExternalPackages: ['@prisma/client', 'bullmq', 'ioredis', 'pino', '@node-rs/argon2'],
  // BACKLOG 20.7: render fonts in public/fonts/ are fetched by Shotstack and the FFmpeg workers
  // (src/lib/studio/fonts-host.ts). Not content-hashed, so cached for a day, not forever; readable
  // from any origin (fonts are public, OFL/Apache licensed).
  async headers() {
    return [
      {
        source: '/fonts/:file*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
        ],
      },
    ];
  },
};

// BACKLOG 16.1 — next-intl without i18n routing: the plugin wires src/i18n/request.ts (the
// per-request locale + catalogue) into getLocale()/getMessages() for Server Components
// (https://next-intl.dev/docs/getting-started/app-router/without-i18n-routing).
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

export default withNextIntl(nextConfig);
