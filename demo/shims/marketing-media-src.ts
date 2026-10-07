// Demo stand-in for src/lib/marketing/media-src.ts (swapped in by scripts/demo/build.mjs): the
// single-file demo cannot load /marketing/… from its host, so the files the pages use are bundled
// as data: URLs (esbuild loader '.webp': 'dataurl'). test/unit/marketing-media.test.ts checks that
// this list covers src/lib/marketing/media.ts. (TypeScript sees Next's StaticImageData type for
// image imports; esbuild's dataurl loader makes each one a string, checked below.)
//
// 25.5: to keep the demo small, each Studio clip is inlined once — its 720 px WebP poster, which
// also stands in for the 360 px poster and the JPEG fallback — and its video is left out (an
// empty URL), so the demo's landing page shows posters only.

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
import screensScriptLight from '../../public/marketing/screens/script-light.webp';
import screensScriptDark from '../../public/marketing/screens/script-dark.webp';
import screensGenerateLight from '../../public/marketing/screens/generate-light.webp';
import screensGenerateDark from '../../public/marketing/screens/generate-dark.webp';
import screensCalendarLight from '../../public/marketing/screens/calendar-light.webp';
import screensCalendarDark from '../../public/marketing/screens/calendar-dark.webp';
import screensAnalyticsLight from '../../public/marketing/screens/analytics-light.webp';
import screensAnalyticsDark from '../../public/marketing/screens/analytics-dark.webp';
import studioSeedanceBread720 from '../../public/marketing/studio/seedance-bread-720.webp';
import studioSeedanceMarket720 from '../../public/marketing/studio/seedance-market-720.webp';
import studioNorthsideBakerySlideshow720 from '../../public/marketing/studio/northside-bakery-slideshow-720.webp';
import studioAtelierWrenSlideshow720 from '../../public/marketing/studio/atelier-wren-slideshow-720.webp';
import studioPulseStudioSlideshow720 from '../../public/marketing/studio/pulse-studio-slideshow-720.webp';
import studioCoastlineStaysSlideshow720 from '../../public/marketing/studio/coastline-stays-slideshow-720.webp';
import studioGreenleafFloristSlideshow720 from '../../public/marketing/studio/greenleaf-florist-slideshow-720.webp';
import studioHarbourCoffeeSlideshow720 from '../../public/marketing/studio/harbour-coffee-slideshow-720.webp';
import studioPulseStudioWallOfText720 from '../../public/marketing/studio/pulse-studio-wall-of-text-720.webp';
import studioCoastlineStaysWallOfText720 from '../../public/marketing/studio/coastline-stays-wall-of-text-720.webp';

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
  'screens/script-light.webp': screensScriptLight,
  'screens/script-dark.webp': screensScriptDark,
  'screens/generate-light.webp': screensGenerateLight,
  'screens/generate-dark.webp': screensGenerateDark,
  'screens/calendar-light.webp': screensCalendarLight,
  'screens/calendar-dark.webp': screensCalendarDark,
  'screens/analytics-light.webp': screensAnalyticsLight,
  'screens/analytics-dark.webp': screensAnalyticsDark,
  'studio/seedance-bread-720.webp': studioSeedanceBread720,
  'studio/seedance-market-720.webp': studioSeedanceMarket720,
  'studio/northside-bakery-slideshow-720.webp': studioNorthsideBakerySlideshow720,
  'studio/atelier-wren-slideshow-720.webp': studioAtelierWrenSlideshow720,
  'studio/pulse-studio-slideshow-720.webp': studioPulseStudioSlideshow720,
  'studio/coastline-stays-slideshow-720.webp': studioCoastlineStaysSlideshow720,
  'studio/greenleaf-florist-slideshow-720.webp': studioGreenleafFloristSlideshow720,
  'studio/harbour-coffee-slideshow-720.webp': studioHarbourCoffeeSlideshow720,
  'studio/pulse-studio-wall-of-text-720.webp': studioPulseStudioWallOfText720,
  'studio/coastline-stays-wall-of-text-720.webp': studioCoastlineStaysWallOfText720,
};

/** studio/<id>-360.webp and studio/<id>.jpg → the inlined studio/<id>-720.webp. */
const POSTER_ALIAS = /^studio\/(.+?)(?:-360\.webp|\.jpg)$/;

export function marketingSrc(path: string): string {
  const alias = POSTER_ALIAS.exec(path);
  const url = FILES[alias ? `studio/${alias[1]}-720.webp` : path];
  return typeof url === 'string' ? url : '';
}
