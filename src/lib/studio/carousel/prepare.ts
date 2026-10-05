// From a stored carousel to slide plans (21.6): clean every post's text for the font stack, then
// break the thread into slides. Shared by the editor preview and the render worker so both show
// exactly the same slides.
import { planSlides } from './breakdown';
import type { FontStack } from './fonts';
import type { Direction } from './layout';
import { cleanSlideText } from './text';
import type { CarouselDocument, CarouselPost, CarouselProfile, SlidePlan } from './types';
import { isRtl } from '../i18n/scripts';

export interface PreparedCarousel {
  readonly posts: readonly CarouselPost[];
  readonly profile: CarouselProfile;
  readonly plans: readonly SlidePlan[];
  readonly direction: Direction;
  /** Characters removed because no bundled font can draw them (emoji and similar). */
  readonly removedCharacters: number;
}

export function prepareCarousel(doc: CarouselDocument, fonts: FontStack): PreparedCarousel {
  let removed = 0;
  const posts = doc.posts.map((post) => {
    const clean = cleanSlideText(post.text, fonts.covered);
    removed += clean.removed;
    return { ...post, text: clean.text };
  });
  const profileName = cleanSlideText(doc.profile.displayName, fonts.covered);
  removed += profileName.removed;
  return {
    posts,
    profile: { ...doc.profile, displayName: profileName.text },
    plans: planSlides(posts, fonts.measure),
    direction: isRtl(doc.language) ? 'rtl' : 'ltr',
    removedCharacters: removed,
  };
}
