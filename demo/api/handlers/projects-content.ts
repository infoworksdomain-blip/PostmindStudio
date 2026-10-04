// Sample creative content for every demo project: the brief Studio wrote from the owner's words
// and the shot list (scene, camera, narration, on-screen text). Leeds Sourdough is fictional.
import type { SceneKind } from '../../media';

export type Treatment =
  | 'AI_CLIP'
  | 'AI_AVATAR'
  | 'STOCK_FOOTAGE'
  | 'IMAGE_STILL'
  | 'MOTION_GRAPHICS'
  | 'USER_UPLOAD'
  | 'TEXT_CARD'
  | 'TRANSITION'
  | 'UGC_ACTOR';

export interface ShotContent {
  scene: string;
  camera: string | null;
  voiceover: string | null;
  onScreen: string | null;
  treatment: Treatment;
  durationSec: number;
  kind: SceneKind;
  transitionOut?: string;
}

export interface BriefContent {
  hook: string;
  keyMessage: string;
  targetAudience: string;
  tone: string;
}

export interface ProjectContent {
  scene: SceneKind;
  brief: BriefContent | null;
  shots: ShotContent[];
}

const shot = (
  treatment: Treatment,
  durationSec: number,
  kind: SceneKind,
  scene: string,
  camera: string | null,
  voiceover: string | null,
  onScreen: string | null,
): ShotContent => ({ treatment, durationSec, kind, scene, camera, voiceover, onScreen });

export const CONTENT: Record<string, ProjectContent> = {
  // 21.4: a UGC actor video. A generated creator (never a real person) speaks every line on
  // camera; Veo's own audio is the narration, so no voice-over asset exists for those shots.
  'prj-ugc-bread-box': {
    scene: 'kitchen',
    brief: {
      hook: 'Okay, my mornings used to be chaos.',
      keyMessage: 'The weekly bread box turns up fresh every Friday, no queue, no stale loaf.',
      targetAudience: 'Busy professionals in Leeds who love good bread',
      tone: 'Warm, honest, conversational',
    },
    shots: [
      shot(
        'UGC_ACTOR',
        8,
        'kitchen',
        'Holds the bread box up to the phone and smiles.',
        'Handheld selfie, arm’s length',
        'Okay, my mornings used to be chaos. Then this box turned up.',
        null,
      ),
      shot(
        'IMAGE_STILL',
        3,
        'sourdough',
        'The bread box with a sourdough loaf and two buns.',
        null,
        null,
        'Fresh every Friday',
      ),
      shot(
        'UGC_ACTOR',
        8,
        'kitchen',
        'Tears a warm loaf open and shows the crumb to the camera.',
        'Close selfie',
        'Look at that crumb. It still smells like the bakery when it arrives.',
        null,
      ),
      shot(
        'UGC_ACTOR',
        8,
        'kitchen',
        'Points at the camera, relaxed and smiling.',
        'Handheld selfie',
        'Honestly, just try one week. The link is right below.',
        null,
      ),
      shot('TEXT_CARD', 3, 'street', 'End card.', null, null, 'Leeds Sourdough · bread box'),
    ],
  },
  'prj-spring-menu': {
    scene: 'flatlay',
    brief: {
      hook: 'Three new small plates. One week at 20% off.',
      keyMessage:
        'The spring menu launches Friday with wild garlic focaccia, rhubarb buns and a pea-and-mint toastie.',
      targetAudience: 'Leeds food lovers, 25–45, who brunch at weekends',
      tone: 'Warm, bright, a little playful',
    },
    shots: [
      shot(
        'AI_CLIP',
        3,
        'storefront',
        'Morning light on the Leeds Sourdough shopfront, chalkboard reading "Spring is here".',
        'Slow push-in from across the street',
        'Spring has landed at Leeds Sourdough.',
        'SPRING MENU — FRIDAY',
      ),
      shot(
        'AI_CLIP',
        5,
        'sourdough',
        'Wild garlic focaccia pulled from the oven, oil bubbling in the dimples.',
        'Overhead, gentle tilt',
        'Wild garlic focaccia, straight from the deck oven.',
        'Wild garlic focaccia',
      ),
      shot(
        'AI_CLIP',
        5,
        'croissant',
        'Rhubarb and custard buns being glazed on a cooling rack.',
        'Macro slider left to right',
        'Rhubarb and custard buns with a proper glaze.',
        'Rhubarb & custard bun',
      ),
      shot(
        'STOCK_FOOTAGE',
        5,
        'coffee',
        'A pea-and-mint toastie cut in half beside a flat white.',
        'Close-up, shallow focus',
        'And a pea-and-mint toastie made for Saturday mornings.',
        'Pea & mint toastie',
      ),
      shot(
        'MOTION_GRAPHICS',
        4,
        'logo',
        'Animated price tag slides in: 20% off all week.',
        null,
        'Twenty per cent off, all launch week.',
        '20% OFF · LAUNCH WEEK',
      ),
      shot(
        'TEXT_CARD',
        3,
        'street',
        'End card with address and opening hours.',
        null,
        'See you on Call Lane.',
        'Call Lane, Leeds · from 7am',
      ),
    ],
  },
  'prj-sourdough-class': {
    scene: 'baker',
    brief: {
      hook: 'Bake your first proper loaf this Saturday.',
      keyMessage:
        'A three-hour hands-on sourdough class: starter, shaping, scoring — you take your loaf home.',
      targetAudience: 'Home bakers and gift buyers in West Yorkshire',
      tone: 'Encouraging, hands-on, friendly',
    },
    shots: [
      shot(
        'AI_AVATAR',
        4,
        'baker',
        'Head baker Tom greets the camera, flour on his apron.',
        'Medium shot, eye level',
        'Always wanted to bake real sourdough? Come and learn with us.',
        'Saturday sourdough class',
      ),
      shot(
        'AI_CLIP',
        5,
        'kitchen',
        'Hands stretching and folding a wet dough on a floured bench.',
        'Top-down',
        'We start with the starter, then stretch and fold.',
        'Stretch & fold',
      ),
      shot(
        'AI_CLIP',
        5,
        'sourdough',
        'A lame scoring a wheat-ear pattern into a proofed loaf.',
        'Macro',
        'You will learn to shape and score like a pro.',
        'Shape · score · bake',
      ),
      shot(
        'STOCK_FOOTAGE',
        4,
        'market',
        'Happy class members holding their loaves.',
        'Handheld, warm',
        'And you take your own loaf home.',
        'Your loaf, your bragging rights',
      ),
      shot(
        'TEXT_CARD',
        3,
        'logo',
        'End card with booking details.',
        null,
        'Six places. Book at the counter or online.',
        '£45 · 10am Saturday · 6 places',
      ),
    ],
  },
  'prj-loyalty-card': {
    scene: 'coffee',
    brief: {
      hook: 'Your tenth coffee is on us — again.',
      keyMessage: 'The Leeds Sourdough loyalty card is back, now on your phone.',
      targetAudience: 'Weekday commuters and regulars',
      tone: 'Upbeat and quick',
    },
    shots: [
      shot(
        'AI_CLIP',
        4,
        'coffee',
        'Latte art being poured in slow motion.',
        'Close-up',
        'Good news for regulars.',
        'The loyalty card is back',
      ),
      shot(
        'MOTION_GRAPHICS',
        5,
        'studio',
        'Phone screen filling up with ten stamp icons.',
        null,
        'Collect a stamp with every coffee, right on your phone.',
        '10 stamps = 1 free coffee',
      ),
      shot(
        'AI_CLIP',
        4,
        'croissant',
        'A croissant and a coffee pushed across the counter.',
        'Over the shoulder',
        'Your tenth one is on us.',
        'Tenth one free',
      ),
      shot(
        'TEXT_CARD',
        3,
        'logo',
        'End card.',
        null,
        'Ask at the till to join.',
        'Ask at the till',
      ),
    ],
  },
  'prj-hot-cross-buns': {
    scene: 'croissant',
    brief: {
      hook: 'They’re back — and they sold out last year in two days.',
      keyMessage: 'Hot cross buns return for Easter, baked fresh every morning from Thursday.',
      targetAudience: 'Families and office orderers',
      tone: 'Excited, seasonal',
    },
    shots: [
      shot(
        'AI_CLIP',
        4,
        'croissant',
        'Trays of hot cross buns lined up under warm lights.',
        'Slow dolly',
        'They’re back.',
        'HOT CROSS BUNS ARE BACK',
      ),
      shot(
        'AI_CLIP',
        5,
        'sourdough',
        'A bun torn open, steam rising, butter melting.',
        'Macro',
        'Spiced, sticky and baked every single morning.',
        'Baked every morning',
      ),
      shot(
        'STOCK_FOOTAGE',
        4,
        'market',
        'Queue outside the shop on a bright morning.',
        'Wide',
        'Last year they sold out in two days.',
        'Sold out in 2 days last year',
      ),
      shot(
        'TEXT_CARD',
        3,
        'logo',
        'End card with pre-order line.',
        null,
        'Pre-order a dozen for the office.',
        'Pre-order: £14 a dozen',
      ),
    ],
  },
  'prj-five-bakes': { scene: 'cake', brief: null, shots: [] },
  'prj-morning-ritual': {
    scene: 'baker',
    brief: {
      hook: 'POV: it’s 5am at a neighbourhood bakery.',
      keyMessage: 'Every loaf starts before sunrise — this is what that looks like.',
      targetAudience: 'Local followers who love behind-the-scenes content',
      tone: 'Calm, atmospheric, ASMR-leaning',
    },
    shots: [
      shot(
        'AI_CLIP',
        3,
        'street',
        'Dark street, the shop lights flicker on at 5am.',
        'Static wide',
        null,
        '5:00am',
      ),
      shot(
        'AI_CLIP',
        4,
        'kitchen',
        'Dough tubs lined up, lids popping off.',
        'Top-down',
        'The dough has been proving overnight.',
        'Overnight prove',
      ),
      shot(
        'AI_CLIP',
        4,
        'baker',
        'Baker loading loaves into the deck oven with a peel.',
        'Side-on tracking',
        'Into the oven by half five.',
        '5:30am',
      ),
      shot(
        'AI_CLIP',
        4,
        'sourdough',
        'Loaves crackling on the rack as they cool.',
        'Macro, listen for the crackle',
        null,
        'Listen…',
      ),
      shot(
        'TEXT_CARD',
        3,
        'storefront',
        'Shutters go up, first customer at the door.',
        null,
        'Doors open at seven.',
        'Open 7am · Call Lane',
      ),
    ],
  },
  'prj-wholesale': {
    scene: 'market',
    brief: {
      hook: 'Fresh bread at your café door before 7am.',
      keyMessage:
        'Wholesale sourdough, focaccia and pastries for Leeds cafés, with daily delivery.',
      targetAudience: 'Independent café and restaurant owners in Leeds',
      tone: 'Professional, reliable, warm',
    },
    shots: [
      shot(
        'AI_CLIP',
        5,
        'street',
        'The delivery van pulling up outside a café at dawn.',
        'Wide, then follow',
        'Every morning, before your doors open…',
        'Before 7am, every day',
      ),
      shot(
        'AI_CLIP',
        6,
        'sourdough',
        'Crates of loaves being stacked on a café counter.',
        'Medium',
        'we deliver sourdough, focaccia and pastries baked that night.',
        'Baked overnight',
      ),
      shot(
        'AI_AVATAR',
        7,
        'baker',
        'Owner Amara explaining the wholesale range.',
        'Interview framing',
        'Twenty cafés across Leeds already serve our bread.',
        '20+ Leeds cafés',
      ),
      shot(
        'TEXT_CARD',
        4,
        'logo',
        'End card with wholesale email.',
        null,
        'Get a sample box this week.',
        'wholesale@leedssourdough.example',
      ),
    ],
  },
  'prj-christmas-preorders': {
    scene: 'cake',
    brief: {
      hook: 'Christmas pre-orders are open — stollen, panettone, mince pies.',
      keyMessage: 'Order by 18 December, collect on Christmas Eve.',
      targetAudience: 'Local families planning Christmas',
      tone: 'Festive and cosy',
    },
    shots: [
      shot(
        'AI_CLIP',
        4,
        'cake',
        'Stollen dusted with icing sugar under fairy lights.',
        'Slow push-in',
        'Christmas at Leeds Sourdough.',
        'Christmas pre-orders open',
      ),
      shot(
        'AI_CLIP',
        5,
        'croissant',
        'Panettone being sliced to show the crumb.',
        'Close-up',
        'Stollen, panettone and our famous mince pies.',
        'Stollen · Panettone · Mince pies',
      ),
      shot(
        'AI_CLIP',
        5,
        'storefront',
        'Snowy shopfront with a wreath on the door.',
        'Wide',
        'Order by the eighteenth, collect Christmas Eve.',
        'Order by 18 Dec',
      ),
      shot(
        'TEXT_CARD',
        3,
        'logo',
        'End card.',
        null,
        'Pre-order in store or online.',
        'Collect 24 Dec',
      ),
    ],
  },
  'prj-meet-the-bakers': { scene: 'baker', brief: null, shots: [] },
};

/** Generic content for projects created in the demo (from the Create screen). */
export function contentForBrief(brief: string): ProjectContent {
  const topic =
    brief
      .trim()
      .split(/[.!?\n]/)[0]
      ?.slice(0, 80) || 'Something new at Leeds Sourdough';
  return {
    scene: 'sourdough',
    brief: {
      hook: topic,
      keyMessage: brief.trim().slice(0, 240) || topic,
      targetAudience: 'Leeds locals who follow the bakery',
      tone: 'Warm, confident, local',
    },
    shots: [
      shot(
        'AI_CLIP',
        4,
        'storefront',
        'The shopfront at opening time, light spilling onto the pavement.',
        'Slow push-in',
        'Here’s what’s new at Leeds Sourdough.',
        topic.toUpperCase().slice(0, 40),
      ),
      shot(
        'AI_CLIP',
        5,
        'sourdough',
        'A fresh bake coming out of the oven.',
        'Overhead',
        topic + '.',
        'Fresh today',
      ),
      shot(
        'STOCK_FOOTAGE',
        5,
        'coffee',
        'A customer enjoying it with a coffee by the window.',
        'Close-up, shallow focus',
        'Made by hand, every morning.',
        'Made by hand',
      ),
      shot(
        'TEXT_CARD',
        3,
        'logo',
        'End card with address.',
        null,
        'Come and see us on Call Lane.',
        'Call Lane, Leeds',
      ),
    ],
  };
}
