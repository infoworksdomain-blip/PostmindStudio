// Stable ids and names shared by every demo API area, so a project seen on the Projects screen is
// the same one its publications, analytics and notifications refer to. Sample business: Leeds
// Sourdough, an independent bakery (every name here is fictional sample data).

export const DEMO_ORG_ID = 'org-leeds-sourdough';
export const DEMO_USER_ID = 'user-amara';
export const DEMO_USER_NAME = 'Amara Okafor';
export const DEMO_BUSINESS_ID = 'biz-leeds-sourdough';
export const DEMO_BUSINESS_NAME = 'Leeds Sourdough';

/** Projects, one per interesting state/source type. */
export const PROJECTS = {
  /** READY_FOR_REVIEW, BRIEF, 3 formats (TikTok, Shorts, Reels) — the main review walkthrough. */
  springMenu: { id: 'prj-spring-menu', name: 'Spring menu launch' },
  /** PUBLISHED to TikTok + YouTube Shorts + Instagram; analytics flowing. */
  sourdoughClass: { id: 'prj-sourdough-class', name: 'Saturday sourdough class' },
  /** RENDERING (live pipeline). */
  loyaltyCard: { id: 'prj-loyalty-card', name: 'Loyalty card relaunch' },
  /** QUALITY_FAILED (loudness) — force-approve path. */
  hotCrossBuns: { id: 'prj-hot-cross-buns', name: 'Hot cross buns are back' },
  /** SLIDESHOW (listicle_5) READY_FOR_REVIEW. */
  fiveBakes: { id: 'prj-five-bakes', name: '5 bakes to try this weekend' },
  /** LIBRARY_REFERENCE (TEMPLATE mode) APPROVED, auto-publish targets armed. */
  morningRitual: { id: 'prj-morning-ritual', name: 'Our morning ritual' },
  /** PARTIALLY_PUBLISHED — LinkedIn failed. */
  wholesale: { id: 'prj-wholesale', name: 'Wholesale for cafés' },
  /** FAILED with cost_cap_paused (budget raise path). */
  christmas: { id: 'prj-christmas-preorders', name: 'Christmas pre-orders open' },
  /** DRAFT. */
  meetTheBakers: { id: 'prj-meet-the-bakers', name: 'Meet the bakers' },
  /** 21.4: a UGC actor video READY_FOR_REVIEW (a generated creator reviews the bread box). */
  ugcReview: { id: 'prj-ugc-bread-box', name: 'Creator review: the bread box' },
} as const;

/**
 * Phase 17 states (p17-hardening.ts): coded failure reasons (17.9) and an unnamed project. The
 * untitled one has no name at all (null): every screen shows its translated "Untitled video".
 */
export const P17_PROJECTS = {
  /** FAILED: planning_failed wrapping kill_switch_workspace (a nested cause). */
  easterWindow: { id: 'prj-easter-window', name: 'Easter window display' },
  /** FAILED: asset_generation_failed for shots 2 and 4 (each shot names its provider error). */
  gardenBakes: { id: 'prj-garden-bakes', name: 'Summer garden bakes' },
  /** FAILED: content_safety_block from the rendered-video scan. */
  knifeSkills: { id: 'prj-knife-skills', name: 'Bread-knife skills' },
  /** READY_FOR_REVIEW with name null. */
  untitled: { id: 'prj-untitled-rye', name: null },
} as const;

/** Phase 20.3 (p20-schedule-month.ts): approved as "next free slot" when none was free. */
export const P20_PROJECTS = {
  harvestLoaf: { id: 'prj-harvest-loaf', name: 'Harvest loaf week' },
} as const;

/** Renders (variants): project → platform. */
export const RENDERS = {
  springTiktok: 'rnd-spring-tiktok',
  springShorts: 'rnd-spring-shorts',
  springReels: 'rnd-spring-reels',
  classTiktok: 'rnd-class-tiktok',
  classShorts: 'rnd-class-shorts',
  classReels: 'rnd-class-reels',
  bunsTiktok: 'rnd-buns-tiktok',
  fiveBakesTiktok: 'rnd-five-bakes-tiktok',
  ritualTiktok: 'rnd-ritual-tiktok',
  ritualShorts: 'rnd-ritual-shorts',
  wholesaleLinkedin: 'rnd-wholesale-linkedin',
  wholesaleYoutube: 'rnd-wholesale-youtube',
} as const;

/** Platform connections. */
export const CONNECTIONS = {
  tiktok: { id: 'conn-tiktok', account: '@leedssourdough', accountId: 'tt-7781' },
  youtube: { id: 'conn-youtube', account: 'Leeds Sourdough', accountId: 'UC-leeds-sourdough' },
  linkedin: { id: 'conn-linkedin', account: 'Leeds Sourdough Ltd', accountId: 'li-urn-5521' },
  x: { id: 'conn-x', account: '@leeds_sourdough', accountId: 'x-9912', needsReconnect: true },
  instagram: { id: 'conn-instagram', account: 'leedssourdough', accountId: '17841400000000001' },
  facebook: { id: 'conn-facebook', account: 'Leeds Sourdough', accountId: '100000000000001' },
} as const;

/** Publications. */
export const PUBLICATIONS = {
  classTiktok: 'pub-class-tiktok',
  classShorts: 'pub-class-shorts',
  classReels: 'pub-class-reels',
  wholesaleYoutube: 'pub-wholesale-youtube',
  wholesaleLinkedin: 'pub-wholesale-linkedin', // FAILED
  ritualTiktokScheduled: 'pub-ritual-tiktok', // SCHEDULED (future)
  ritualShortsScheduled: 'pub-ritual-shorts', // SCHEDULED (future)
  bunsLastYear: 'pub-buns-2025', // TAKEN_DOWN
} as const;

/** Reference library videos. */
export const LIBRARY_VIDEOS = [
  { id: 'lib-pov-morning-bake', title: 'POV: 5am at a neighbourhood bakery' },
  { id: 'lib-three-step-recipe', title: 'Three-step focaccia, no mixer' },
  { id: 'lib-before-after-shopfit', title: 'Café fit-out: before and after' },
  { id: 'lib-founder-story', title: 'Why I quit finance to bake bread' },
  { id: 'lib-listicle-cakes', title: '5 cakes our regulars order most' },
  { id: 'lib-asmr-crust', title: 'Crust crackle ASMR' },
  { id: 'lib-day-in-life', title: 'A day in the life of a pastry chef' },
  { id: 'lib-product-drop', title: 'Limited drop: the cardamom bun' },
  { id: 'lib-ugc-review', title: 'Customer taste test reactions' },
] as const;

export const TEMPLATES = {
  introduce: { id: 'tpl-introduce-yourself', name: 'Introduce yourself and what you do' },
  weeklySpecial: { id: 'tpl-weekly-special', name: 'Weekly special (Leeds Sourdough)' },
} as const;

export const SLIDESHOW_TEMPLATES = {
  listicle5: 'sst-listicle-5',
  beforeAfter: 'sst-before-after',
  photoDump: 'sst-photo-dump',
} as const;

export const BRAND_KITS = {
  main: { id: 'bk-main', name: 'Leeds Sourdough — main' },
  seasonal: { id: 'bk-seasonal', name: 'Christmas 2026' },
} as const;
