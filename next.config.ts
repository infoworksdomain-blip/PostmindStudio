import type { NextConfig } from 'next';

// Studio is used mostly as an API server (same pattern as the Engagement service).
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Server-only packages are loaded at runtime in Node rather than bundled.
  serverExternalPackages: ['@prisma/client', 'bullmq', 'ioredis', 'pino'],
};

export default nextConfig;
