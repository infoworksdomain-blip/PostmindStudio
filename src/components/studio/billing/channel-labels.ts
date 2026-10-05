// 21.5 — a channel's name (platform_connections.platform). Brand names, never translated
// (Phase 16 rule); an unknown platform shows as stored.

const CHANNEL_LABEL: Readonly<Record<string, string>> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  youtube: 'YouTube',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  x: 'X',
};

export function channelLabel(platform: string): string {
  return CHANNEL_LABEL[platform] ?? platform;
}

/** "TikTok, Instagram" */
export function channelList(platforms: readonly string[]): string {
  return platforms.map(channelLabel).join(', ');
}
