import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// Studio is used mostly as an API server (same pattern as the Engagement service).
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Server-only packages are loaded at runtime in Node rather than bundled.
  serverExternalPackages: ['@prisma/client', 'bullmq', 'ioredis', 'pino', '@node-rs/argon2'],
};

// BACKLOG 16.1 — next-intl without i18n routing: the plugin wires src/i18n/request.ts (the
// per-request locale + catalogue) into getLocale()/getMessages() for Server Components
// (https://next-intl.dev/docs/getting-started/app-router/without-i18n-routing).
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

export default withNextIntl(nextConfig);
