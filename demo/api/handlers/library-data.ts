// Reference library sample catalogue (agent "insight"). Categories come from the real taxonomy
// file; videos are the ids.ts LIBRARY_VIDEOS plus more, each with a licence scenario, analysis
// and a shot list generated from its structure pattern.
import taxonomy from '../../../prisma/data/library-taxonomy.json';
import type { SceneKind } from '../../media';
import { LIBRARY_VIDEOS } from '../ids';

export type LicenseScenario = 'LICENSED' | 'OWNED' | 'SCRAPED' | 'NOT_REQUIRED';

export interface CategoryNode {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  depth: number;
  children: CategoryNode[];
}

interface TaxonomyNode {
  name: string;
  children?: TaxonomyNode[];
}

const slugPart = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function buildTree(nodes: TaxonomyNode[], parent: CategoryNode | null): CategoryNode[] {
  return nodes.map((n) => {
    const slug = parent ? `${parent.slug}/${slugPart(n.name)}` : slugPart(n.name);
    const node: CategoryNode = {
      id: `cat-${slug.replace(/\//g, '-')}`,
      slug,
      name: n.name,
      parentId: parent?.id ?? null,
      depth: parent ? parent.depth + 1 : 0,
      children: [],
    };
    node.children = buildTree(n.children ?? [], node);
    return node;
  });
}

export const CATEGORY_TREE: CategoryNode[] = buildTree(
  (taxonomy as { categories: TaxonomyNode[] }).categories,
  null,
);

const CATEGORY_NAMES = new Map<string, string>();
(function index(list: CategoryNode[]) {
  for (const c of list) {
    CATEGORY_NAMES.set(c.slug, c.name);
    index(c.children);
  }
})(CATEGORY_TREE);

export const categoryName = (slug: string): string | undefined => CATEGORY_NAMES.get(slug);

// ------------------------------------------------------------------ shots

export interface Shot {
  startSec: number;
  endSec: number;
  type: string;
  description: string;
  onScreenText: string;
  overlayStyle: string;
  voiceoverPresent: boolean;
}

/** [weight, type, overlay, voiceover, description, onScreenText] */
type ShotSpec = [number, string, string, boolean, string, string];

const STRUCTURES: Record<string, { shots: ShotSpec[]; transitions: string[] }> = {
  'hook-process-reveal-cta': {
    shots: [
      [
        2,
        'HOOK_TEXT_ON_STILL',
        'bold-centre',
        false,
        'Close-up still with a bold question',
        '{hook}',
      ],
      [3, 'B_ROLL', 'none', true, 'Hands at work, shallow depth of field', ''],
      [3, 'AI_CLIP_ACTION', 'subtitle-lower', true, 'The key moment of the process', ''],
      [2, 'B_ROLL', 'none', true, 'Detail cutaway', ''],
      [
        3,
        'PRODUCT_SHOT',
        'caption-box',
        false,
        'Hero reveal of the finished product',
        'Ready at 8am',
      ],
      [2, 'CTA_CARD', 'bold-bottom', false, 'End card with shop name', 'Order ahead — link in bio'],
    ],
    transitions: ['cut', 'cut', 'whip-pan', 'cut', 'match-cut', 'cut'],
  },
  listicle: {
    shots: [
      [2, 'HOOK_TEXT_ON_STILL', 'big-number', false, 'Numbered title over a flat lay', '{hook}'],
      [3, 'PRODUCT_SHOT', 'big-number', true, 'Item 1 on a board', '1'],
      [3, 'PRODUCT_SHOT', 'big-number', true, 'Item 2, slow push-in', '2'],
      [3, 'PRODUCT_SHOT', 'big-number', true, 'Item 3, overhead', '3'],
      [3, 'PRODUCT_SHOT', 'big-number', true, 'Item 4 being sliced', '4'],
      [3, 'PRODUCT_SHOT', 'big-number', true, 'Item 5, the favourite', '5'],
      [2, 'CTA_CARD', 'bold-centre', false, 'Which one are you having?', 'Which is yours?'],
    ],
    transitions: ['cut', 'jump-cut', 'jump-cut', 'jump-cut', 'jump-cut', 'cut', 'cut'],
  },
  'before-after': {
    shots: [
      [2, 'HOOK_TEXT_ON_STILL', 'bold-top', false, 'The "before" frame with a promise', '{hook}'],
      [3, 'B_ROLL', 'caption-box', true, 'Wide shot of the before state', 'Before'],
      [1, 'TEXT_CARD', 'bold-centre', false, 'Transition card', '3 weeks later…'],
      [3, 'STOCK_LIFESTYLE', 'none', true, 'Reveal wide of the after state', ''],
      [3, 'PRODUCT_SHOT', 'caption-box', true, 'Detail of the finish', 'After'],
      [2, 'CTA_CARD', 'bold-bottom', false, 'Call to book', 'Book a visit'],
    ],
    transitions: ['cut', 'cut', 'dissolve', 'cut', 'cut', 'cut'],
  },
  'story-arc': {
    shots: [
      [
        4,
        'TALKING_HEAD',
        'subtitle-lower',
        true,
        'Founder to camera, a surprising opener',
        '{hook}',
      ],
      [3, 'B_ROLL', 'none', true, 'Archive-style photo of the old job', ''],
      [5, 'TALKING_HEAD', 'subtitle-lower', true, 'The turning point', ''],
      [
        3,
        'B_ROLL',
        'quote',
        true,
        'Early days in the kitchen',
        '“Nobody bought a loaf for a week”',
      ],
      [5, 'TALKING_HEAD', 'subtitle-lower', true, 'Where things are now', ''],
      [2, 'CTA_CARD', 'bold-centre', false, 'Invite to visit', 'Come and say hello'],
    ],
    transitions: ['cut', 'dissolve', 'cut', 'dissolve', 'cut', 'cut'],
  },
  'day-in-the-life': {
    shots: [
      [2, 'HOOK_TEXT_ON_STILL', 'bold-top', false, 'Alarm clock close-up', '{hook}'],
      [3, 'B_ROLL', 'caption-box', false, 'Lights on, ovens firing', '5:02am'],
      [3, 'B_ROLL', 'caption-box', false, 'Shaping at the bench', '6:15am'],
      [3, 'AI_CLIP_ACTION', 'caption-box', false, 'Loaves out of the oven', '7:40am'],
      [3, 'STOCK_LIFESTYLE', 'caption-box', false, 'First customers at the door', '8:00am'],
      [3, 'B_ROLL', 'caption-box', false, 'Quiet afternoon clean-down', '2:30pm'],
      [2, 'CTA_CARD', 'bold-bottom', false, 'Follow for more', 'Follow the bake'],
    ],
    transitions: ['cut', 'jump-cut', 'jump-cut', 'jump-cut', 'jump-cut', 'cut', 'cut'],
  },
  'tutorial-steps': {
    shots: [
      [2, 'HOOK_TEXT_ON_STILL', 'bold-centre', false, 'Finished result with a promise', '{hook}'],
      [4, 'AI_CLIP_ACTION', 'big-number', true, 'Step one, overhead', 'Step 1'],
      [4, 'AI_CLIP_ACTION', 'big-number', true, 'Step two, hands in frame', 'Step 2'],
      [4, 'AI_CLIP_ACTION', 'big-number', true, 'Step three, into the oven', 'Step 3'],
      [3, 'PRODUCT_SHOT', 'none', true, 'Tear and crumb shot', ''],
      [2, 'CTA_CARD', 'bold-bottom', false, 'Save for later', 'Save this'],
    ],
    transitions: ['cut', 'cut', 'cut', 'whoosh', 'cut', 'cut'],
  },
  'sensory-loop': {
    shots: [
      [3, 'PRODUCT_SHOT', 'none', false, 'Macro of the surface', ''],
      [3, 'B_ROLL', 'none', false, 'Slow squeeze or pour', ''],
      [3, 'PRODUCT_SHOT', 'none', false, 'The satisfying moment, sound up', ''],
      [2, 'B_ROLL', 'none', false, 'Loop point back to the first frame', ''],
    ],
    transitions: ['cut', 'cut', 'cut', 'match-cut'],
  },
  'reaction-montage': {
    shots: [
      [2, 'HOOK_TEXT_ON_STILL', 'quote', false, 'Best reaction as a still', '{hook}'],
      [3, 'TALKING_HEAD', 'subtitle-lower', true, 'Customer one tastes', ''],
      [3, 'TALKING_HEAD', 'subtitle-lower', true, 'Customer two reacts', ''],
      [3, 'TALKING_HEAD', 'subtitle-lower', true, 'Customer three verdict', ''],
      [
        3,
        'PRODUCT_SHOT',
        'caption-box',
        false,
        'The product they tried',
        'The one everyone orders',
      ],
      [2, 'CTA_CARD', 'bold-bottom', false, 'Try it yourself', 'Taste it this weekend'],
    ],
    transitions: ['cut', 'jump-cut', 'jump-cut', 'cut', 'cut', 'cut'],
  },
  'screen-demo': {
    shots: [
      [2, 'HOOK_TEXT_ON_STILL', 'bold-top', false, 'Phone mock-up with the promise', '{hook}'],
      [5, 'SCREEN_RECORDING', 'caption-box', true, 'Browse the menu', 'Pick your bake'],
      [5, 'SCREEN_RECORDING', 'caption-box', true, 'Choose a collection slot', 'Choose a time'],
      [4, 'SCREEN_RECORDING', 'caption-box', true, 'Pay in two taps', 'Pay'],
      [3, 'STOCK_LIFESTYLE', 'none', true, 'Collecting the order at the counter', ''],
      [2, 'CTA_CARD', 'bold-bottom', false, 'Download prompt', 'Order ahead today'],
    ],
    transitions: ['cut', 'cut', 'cut', 'cut', 'cut', 'cut'],
  },
};

export const STRUCTURE_TRANSITIONS = (structure: string): string[] =>
  STRUCTURES[structure]?.transitions ?? [];

export function shotsFor(structure: string, durationSec: number, hook: string): Shot[] {
  const specs = STRUCTURES[structure]?.shots ?? [];
  const total = specs.reduce((t, s) => t + s[0], 0) || 1;
  let at = 0;
  return specs.map(([w, type, overlayStyle, voiceoverPresent, description, text], i) => {
    const len =
      i === specs.length - 1 ? durationSec - at : Math.round((w / total) * durationSec * 10) / 10;
    const shot: Shot = {
      startSec: Math.round(at * 10) / 10,
      endSec: Math.round((at + len) * 10) / 10,
      type,
      description,
      onScreenText: text.replace('{hook}', hook),
      overlayStyle,
      voiceoverPresent,
    };
    at += len;
    return shot;
  });
}

// ------------------------------------------------------------------ videos

export interface LibraryItem {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  durationSec: number;
  aspectRatio: string;
  sourcePlatform: string | null;
  sourceUrl: string;
  categorySlug: string;
  scene: SceneKind;
  scenario: LicenseScenario;
  licenseSource: string | null;
  ingestedAt: string;
  retiredAt: string | null;
  analysis: {
    hookPattern: string;
    structurePattern: string;
    ctaPattern: string | null;
    paceTag: 'slow' | 'medium' | 'fast-cut';
    moodTag: string;
    musicGenreTag: string | null;
    bpm: number | null;
    energy: string | null;
    hook: string;
  };
}

type Row = [
  id: string,
  title: string,
  category: string,
  scene: SceneKind,
  duration: number,
  platform: string,
  scenario: LicenseScenario,
  structure: string,
  pace: 'slow' | 'medium' | 'fast-cut',
  mood: string,
  music: [genre: string | null, bpm: number | null, energy: string | null],
  hook: string,
  tags: string[],
  description: string,
];

const ids = Object.fromEntries(LIBRARY_VIDEOS.map((v) => [v.id, v.title])) as Record<
  string,
  string
>;
const t = (id: string) => ids[id] ?? id;

const ROWS: Row[] = [
  [
    'lib-pov-morning-bake',
    t('lib-pov-morning-bake'),
    'entertainment/storytelling/day-in-the-life',
    'baker',
    28,
    'tiktok',
    'NOT_REQUIRED',
    'day-in-the-life',
    'medium',
    'calm-cosy',
    ['lofi-hip-hop', 84, 'low'],
    'POV: your alarm goes at 4:45',
    ['bakery', 'pov', 'morning', 'sourdough'],
    'Timestamped day-in-the-life from lights-on to first customer, no talking — captions carry it.',
  ],
  [
    'lib-three-step-recipe',
    t('lib-three-step-recipe'),
    'education/tutorials/cooking-how-to',
    'flatlay',
    24,
    'instagram',
    'LICENSED',
    'tutorial-steps',
    'fast-cut',
    'upbeat',
    ['acoustic-pop', 112, 'medium'],
    'Focaccia in 3 steps. No mixer.',
    ['recipe', 'focaccia', 'tutorial', 'baking'],
    'Overhead tutorial, one numbered step per shot, crumb shot pay-off.',
  ],
  [
    'lib-before-after-shopfit',
    t('lib-before-after-shopfit'),
    'product-marketing/comparison/before-and-after',
    'storefront',
    18,
    'tiktok',
    'SCRAPED',
    'before-after',
    'fast-cut',
    'satisfying',
    ['house', 124, 'high'],
    'We gutted a launderette…',
    ['shopfit', 'before and after', 'cafe', 'renovation'],
    'Empty unit to opening day in eighteen seconds.',
  ],
  [
    'lib-founder-story',
    t('lib-founder-story'),
    'personal-brand/founder-led/founder-story',
    'baker',
    52,
    'youtube',
    'LICENSED',
    'story-arc',
    'slow',
    'inspiring',
    ['piano-ambient', 72, 'low'],
    'I left a £70k job to bake bread',
    ['founder', 'story', 'small business', 'bakery'],
    'Talking head intercut with archive photos; a quote card at the low point.',
  ],
  [
    'lib-listicle-cakes',
    t('lib-listicle-cakes'),
    'business/local-business/bakeries',
    'cake',
    32,
    'instagram',
    'OWNED',
    'listicle',
    'medium',
    'playful',
    ['indie-pop', 118, 'medium'],
    '5 cakes our regulars order most',
    ['cakes', 'listicle', 'bakery', 'best sellers'],
    'Numbered countdown of best sellers with big-number overlays.',
  ],
  [
    'lib-asmr-crust',
    t('lib-asmr-crust'),
    'lifestyle/food/baking',
    'sourdough',
    12,
    'tiktok',
    'SCRAPED',
    'sensory-loop',
    'slow',
    'calm',
    [null, null, null],
    'Listen to that crust',
    ['asmr', 'sourdough', 'crust', 'satisfying'],
    'Macro crust crackle, no music, seamless loop.',
  ],
  [
    'lib-day-in-life',
    t('lib-day-in-life'),
    'entertainment/storytelling/day-in-the-life',
    'croissant',
    45,
    'youtube',
    'LICENSED',
    'day-in-the-life',
    'medium',
    'warm',
    ['jazz-hop', 90, 'medium'],
    'A day as a pastry chef',
    ['pastry', 'day in the life', 'croissant', 'chef'],
    'Lamination to last tray, captioned by the hour.',
  ],
  [
    'lib-product-drop',
    t('lib-product-drop'),
    'product-marketing/offers/limited-drop',
    'croissant',
    15,
    'tiktok',
    'NOT_REQUIRED',
    'hook-process-reveal-cta',
    'fast-cut',
    'hype',
    ['trap', 140, 'high'],
    'Only 60 of these on Saturday',
    ['limited drop', 'cardamom bun', 'launch', 'scarcity'],
    'Scarcity hook, quick process cuts, hero reveal and a hard CTA.',
  ],
  [
    'lib-ugc-review',
    t('lib-ugc-review'),
    'product-marketing/testimonial/review-montage',
    'coffee',
    26,
    'tiktok',
    'SCRAPED',
    'reaction-montage',
    'fast-cut',
    'joyful',
    ['funk', 108, 'high'],
    '“Best bread in Leeds, easy”',
    ['taste test', 'reviews', 'customers', 'ugc'],
    'Street taste-test reactions cut tight, product shot to finish.',
  ],
  [
    'lib-coffee-pour',
    'The 10-second flat white',
    'business/local-business/cafes',
    'coffee',
    10,
    'instagram',
    'LICENSED',
    'sensory-loop',
    'slow',
    'calm',
    ['lofi-hip-hop', 80, 'low'],
    'Watch the pour',
    ['coffee', 'latte art', 'cafe', 'asmr'],
    'Latte-art pour looped, soft lo-fi bed.',
  ],
  [
    'lib-market-stall',
    'Setting up a Saturday market stall',
    'business/local-business/retail-shops',
    'market',
    35,
    'tiktok',
    'OWNED',
    'day-in-the-life',
    'medium',
    'cheerful',
    ['folk-pop', 104, 'medium'],
    'Market day: 6am set-up',
    ['market', 'stall', 'saturday', 'small business'],
    'Van to sold-out sign, time-stamped.',
  ],
  [
    'lib-meet-the-team',
    'Meet the four people behind the counter',
    'community/team/meet-the-team',
    'baker',
    40,
    'instagram',
    'LICENSED',
    'story-arc',
    'medium',
    'friendly',
    ['acoustic', 96, 'medium'],
    'Meet the team who bake your bread',
    ['team', 'meet the team', 'people', 'culture'],
    'Each team member introduces their bake in one line.',
  ],
  [
    'lib-hiring-baker',
    'We’re hiring: what a shift actually looks like',
    'community/team/hiring',
    'kitchen',
    22,
    'linkedin',
    'NOT_REQUIRED',
    'listicle',
    'medium',
    'honest',
    ['indie-pop', 110, 'medium'],
    '5 things nobody tells you about bakery shifts',
    ['hiring', 'jobs', 'bakery', 'careers'],
    'Honest listicle for a job post, closes on how to apply.',
  ],
  [
    'lib-countdown-launch',
    '3 days until the new menu',
    'product-marketing/launch/countdown',
    'flatlay',
    14,
    'tiktok',
    'LICENSED',
    'hook-process-reveal-cta',
    'fast-cut',
    'anticipation',
    ['electronic', 128, 'high'],
    '3 days. 4 new bakes.',
    ['launch', 'countdown', 'menu', 'teaser'],
    'Teaser cuts that never quite show the product until the last frame.',
  ],
  [
    'lib-myth-busting-sourdough',
    'Sourdough myths, busted',
    'news-and-commentary/opinion/myth-busting',
    'sourdough',
    38,
    'youtube',
    'SCRAPED',
    'story-arc',
    'medium',
    'confident',
    ['none', null, null],
    'No, sourdough isn’t gluten-free',
    ['sourdough', 'myths', 'education', 'health'],
    'Baker to camera answers comments, text cards for each myth.',
  ],
  [
    'lib-packing-orders',
    'Packing 200 Christmas orders',
    'community/behind-the-scenes/packing-orders',
    'flatlay',
    20,
    'tiktok',
    'OWNED',
    'sensory-loop',
    'medium',
    'satisfying',
    ['lofi-hip-hop', 88, 'low'],
    'Pack orders with me',
    ['packing orders', 'christmas', 'behind the scenes', 'asmr'],
    'Tape, tissue, stickers — rhythmic packing loop.',
  ],
  [
    'lib-cafe-review',
    'Rating every café on one Leeds street',
    'lifestyle/food/restaurant-reviews',
    'street',
    30,
    'tiktok',
    'SCRAPED',
    'reaction-montage',
    'fast-cut',
    'playful',
    ['funk', 116, 'high'],
    'Rating every café on Call Lane',
    ['cafe', 'review', 'leeds', 'food'],
    'Scores out of ten on screen, reaction cuts between each stop.',
  ],
  [
    'lib-healthy-swap',
    '5 healthier bakes that still taste like treats',
    'lifestyle/food/healthy-eating',
    'cake',
    27,
    'instagram',
    'LICENSED',
    'listicle',
    'medium',
    'upbeat',
    ['acoustic-pop', 114, 'medium'],
    '5 swaps that don’t taste “healthy”',
    ['healthy', 'baking', 'swaps', 'listicle'],
    'Numbered swaps with calorie callouts.',
  ],
  [
    'lib-sale-announcement',
    'Half-price loaves after 4pm',
    'product-marketing/offers/sale-announcement',
    'storefront',
    11,
    'tiktok',
    'NOT_REQUIRED',
    'hook-process-reveal-cta',
    'fast-cut',
    'urgent',
    ['electronic', 132, 'high'],
    'Half price. After 4pm. Every day.',
    ['sale', 'offer', 'food waste', 'bakery'],
    'Clock-based offer with a map pin CTA.',
  ],
  [
    'lib-charity-bake',
    'Baking 1,000 loaves for the food bank',
    'community/culture/charity-and-giving',
    'sourdough',
    44,
    'youtube',
    'LICENSED',
    'story-arc',
    'slow',
    'heartfelt',
    ['strings', 70, 'low'],
    'We baked 1,000 loaves for Leeds',
    ['charity', 'community', 'food bank', 'giving'],
    'Community story with volunteer interviews and a total on screen.',
  ],
  [
    'lib-city-guide-leeds',
    'A baker’s guide to Leeds in 60 seconds',
    'lifestyle/travel/city-guides',
    'street',
    58,
    'youtube',
    'SCRAPED',
    'listicle',
    'medium',
    'curious',
    ['indie-pop', 106, 'medium'],
    '5 Leeds spots a baker actually goes',
    ['leeds', 'city guide', 'food', 'travel'],
    'Walking guide, one numbered stop per shot.',
  ],
  [
    'lib-salon-transformation',
    'Salon transformation in 20 seconds',
    'business/local-business/salons',
    'studio',
    21,
    'instagram',
    'LICENSED',
    'before-after',
    'fast-cut',
    'confident',
    ['house', 122, 'high'],
    'She asked for “a change”',
    ['salon', 'transformation', 'before and after', 'hair'],
    'Classic before/after structure from another local-business vertical.',
  ],
  [
    'lib-gym-promo',
    'First class free: a gym promo that works',
    'business/local-business/gyms',
    'street',
    16,
    'tiktok',
    'OWNED',
    'hook-process-reveal-cta',
    'fast-cut',
    'energetic',
    ['drum-and-bass', 170, 'high'],
    'Your first class is on us',
    ['gym', 'offer', 'local', 'fitness'],
    'Punchy hook-to-offer format that transfers well to food.',
  ],
  [
    'lib-keynote-clip',
    'What small shops get right about loyalty',
    'personal-brand/speaker/keynote-clips',
    'studio',
    64,
    'youtube',
    'LICENSED',
    'story-arc',
    'slow',
    'thoughtful',
    ['piano-ambient', 68, 'low'],
    'Your regulars aren’t loyal to a card',
    ['loyalty', 'keynote', 'small business', 'retail'],
    'Stage talk clip with subtitles and a pull quote.',
  ],
  [
    'lib-screen-demo',
    'Order-ahead in three taps',
    'product-marketing/feature-demo/screen-recording',
    'logo',
    34,
    'instagram',
    'NOT_REQUIRED',
    'screen-demo',
    'medium',
    'clear',
    ['electronic', 100, 'medium'],
    'Skip the queue on Saturday',
    ['order ahead', 'app', 'demo', 'click and collect'],
    'Phone screen recording with captions, counter pick-up to close.',
  ],
  [
    'lib-croissant-lamination',
    'Why croissants have 81 layers',
    'education/explainers/science-explained',
    'croissant',
    29,
    'tiktok',
    'LICENSED',
    'tutorial-steps',
    'medium',
    'curious',
    ['jazz-hop', 94, 'medium'],
    '81 layers. Here’s why.',
    ['croissant', 'lamination', 'science', 'pastry'],
    'Explainer: folds counted on screen, cross-section pay-off.',
  ],
  [
    'lib-luxury-car-reveal',
    'Luxury car reveal: the first look',
    'lifestyle/luxury/cars',
    'street',
    20,
    'instagram',
    'LICENSED',
    'hook-process-reveal-cta',
    'medium',
    'cinematic',
    ['cinematic-electronic', 98, 'medium'],
    'Meet the car everyone is talking about',
    ['luxury', 'cars', 'supercar', 'reveal'],
    'Luxury car reveal: low-angle walkaround of a supercar in a showroom, engine start, hero shot and a booking CTA.',
  ],
  [
    'lib-luxury-showroom-tour',
    'Inside the luxury car showroom',
    'lifestyle/luxury/cars',
    'storefront',
    34,
    'youtube',
    'LICENSED',
    'day-in-the-life',
    'slow',
    'aspirational',
    ['ambient-house', 92, 'low'],
    'A private tour of the showroom floor',
    ['luxury', 'cars', 'showroom', 'dealership'],
    'Slow showroom tour of luxury cars with captions on each model and a test-drive CTA.',
  ],
];

const DAY = 86_400_000;
const loadedAt = Date.now();

export const LIBRARY: LibraryItem[] = ROWS.map((r, i) => ({
  id: r[0],
  title: r[1],
  description: r[13],
  tags: r[12],
  durationSec: r[4],
  aspectRatio: '9:16',
  sourcePlatform: r[5],
  sourceUrl: `https://www.${r[5] === 'youtube' ? 'youtube.com/shorts' : `${r[5]}.com/p`}/${r[0].slice(4)}`,
  categorySlug: r[2],
  scene: r[3],
  scenario: r[6],
  licenseSource:
    r[6] === 'LICENSED'
      ? 'Creator agreement CA-2026-0' + String(40 + i)
      : r[6] === 'NOT_REQUIRED'
        ? 'Operator decision: public-domain style reference (staff: j.hale)'
        : null,
  ingestedAt: new Date(loadedAt - i * 1.3 * DAY - (i % 5) * 3_600_000).toISOString(),
  retiredAt: null,
  analysis: {
    hookPattern:
      r[7] === 'story-arc' ? 'surprising personal claim to camera' : 'bold text over first frame',
    structurePattern: r[7],
    ctaPattern: r[7] === 'sensory-loop' ? null : 'end card with a single action',
    paceTag: r[8],
    moodTag: r[9],
    musicGenreTag: r[10][0],
    bpm: r[10][1],
    energy: r[10][2],
    hook: r[11],
  },
}));

export const allowedModesFor = (scenario: LicenseScenario): string[] =>
  scenario === 'SCRAPED' ? ['INSPIRE'] : ['TEMPLATE', 'INSPIRE'];
