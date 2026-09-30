// Demo stand-in for src/lib/marketing/media-src.ts (swapped in by scripts/demo/build.mjs): the
// single-file demo cannot load /marketing/… from its host, so every file the pages use is bundled
// as a data: URL (esbuild loader '.webp': 'dataurl'). test/unit/marketing-media.test.ts checks that
// this list covers every file in src/lib/marketing/media.ts. (TypeScript sees Next's StaticImageData
// type for image imports; esbuild's dataurl loader makes each one a string, checked below.)

import photosSourdoughLoaf from '../../public/marketing/photos/sourdough-loaf.webp';
import photosSourdoughHands from '../../public/marketing/photos/sourdough-hands.webp';
import photosSourdoughBoard from '../../public/marketing/photos/sourdough-board.webp';
import photosMarketStall from '../../public/marketing/photos/market-stall.webp';
import photosDoughKneading from '../../public/marketing/photos/dough-kneading.webp';
import photosCroissants from '../../public/marketing/photos/croissants.webp';
import photosCoffee from '../../public/marketing/photos/coffee.webp';
import photosCake from '../../public/marketing/photos/cake.webp';
import photosDoughBalls from '../../public/marketing/photos/dough-balls.webp';
import photosBreakfast from '../../public/marketing/photos/breakfast.webp';
import photosGym from '../../public/marketing/photos/gym.webp';
import photosSalonTools from '../../public/marketing/photos/salon-tools.webp';
import screensBriefLight from '../../public/marketing/screens/brief-light.webp';
import screensBriefDark from '../../public/marketing/screens/brief-dark.webp';
import screensScriptLight from '../../public/marketing/screens/script-light.webp';
import screensScriptDark from '../../public/marketing/screens/script-dark.webp';
import screensGenerateLight from '../../public/marketing/screens/generate-light.webp';
import screensGenerateDark from '../../public/marketing/screens/generate-dark.webp';
import screensReviewLight from '../../public/marketing/screens/review-light.webp';
import screensReviewDark from '../../public/marketing/screens/review-dark.webp';
import screensCalendarLight from '../../public/marketing/screens/calendar-light.webp';
import screensCalendarDark from '../../public/marketing/screens/calendar-dark.webp';
import screensAnalyticsLight from '../../public/marketing/screens/analytics-light.webp';
import screensAnalyticsDark from '../../public/marketing/screens/analytics-dark.webp';

const FILES: Record<string, unknown> = {
  'photos/sourdough-loaf.webp': photosSourdoughLoaf,
  'photos/sourdough-hands.webp': photosSourdoughHands,
  'photos/sourdough-board.webp': photosSourdoughBoard,
  'photos/market-stall.webp': photosMarketStall,
  'photos/dough-kneading.webp': photosDoughKneading,
  'photos/croissants.webp': photosCroissants,
  'photos/coffee.webp': photosCoffee,
  'photos/cake.webp': photosCake,
  'photos/dough-balls.webp': photosDoughBalls,
  'photos/breakfast.webp': photosBreakfast,
  'photos/gym.webp': photosGym,
  'photos/salon-tools.webp': photosSalonTools,
  'screens/brief-light.webp': screensBriefLight,
  'screens/brief-dark.webp': screensBriefDark,
  'screens/script-light.webp': screensScriptLight,
  'screens/script-dark.webp': screensScriptDark,
  'screens/generate-light.webp': screensGenerateLight,
  'screens/generate-dark.webp': screensGenerateDark,
  'screens/review-light.webp': screensReviewLight,
  'screens/review-dark.webp': screensReviewDark,
  'screens/calendar-light.webp': screensCalendarLight,
  'screens/calendar-dark.webp': screensCalendarDark,
  'screens/analytics-light.webp': screensAnalyticsLight,
  'screens/analytics-dark.webp': screensAnalyticsDark,
};

export function marketingSrc(path: string): string {
  const url = FILES[path];
  return typeof url === 'string' ? url : '';
}
