import OpengraphImage from './opengraph-image';

// 26.2 — X (Twitter) cards use the same 1200×630 image as Open Graph. Next reads these exports
// statically, so they are written out rather than re-exported.
export const alt = 'PostMind Studio: create, plan and publish short videos from one brief';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default OpengraphImage;
