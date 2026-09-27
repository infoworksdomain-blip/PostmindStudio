import { createHash } from 'node:crypto';

// Layer 5 music prompt (spec 5.6 "matches the video's tone"; A5.4 slideshow musicMood;
// A3.6 step 5 library musicEnvelope for TEMPLATE / INSPIRE).
//
// Every input here is untrusted free text (the user's brief, brand-kit keywords, template
// fields, descriptors Claude produced from someone else's video). ElevenLabs refuses prompts
// naming artists or quoting lyrics (elevenlabs.io/docs/cookbooks/music/quickstart, "bad_prompt")
// and its music terms prohibit artist names in the input (elevenlabs.io/music-terms). Rather
// than try to detect names, the prompt is FENCED BY VOCABULARY: inputs are reduced to words
// from the closed lists below, everything else is dropped. A name, a lyric or an injected
// instruction therefore cannot reach the provider. The track is always instrumental
// (force_instrumental in the adapter, and "no vocals" in the prompt).

const MOODS = [
  'upbeat',
  'uplifting',
  'energetic',
  'calm',
  'relaxed',
  'warm',
  'confident',
  'playful',
  'inspiring',
  'inspirational',
  'motivational',
  'dramatic',
  'emotional',
  'mysterious',
  'dark',
  'romantic',
  'happy',
  'joyful',
  'cheerful',
  'hopeful',
  'serious',
  'professional',
  'friendly',
  'fun',
  'bold',
  'epic',
  'chill',
  'dreamy',
  'nostalgic',
  'intense',
  'tense',
  'suspenseful',
  'polished',
  'minimal',
  'elegant',
  'luxurious',
  'quirky',
  'reflective',
  'peaceful',
  'bright',
  'soft',
  'gentle',
  'powerful',
  'rhythmic',
  'trendy',
  'trending',
  'modern',
  'sophisticated',
  'optimistic',
  'triumphant',
  'heartfelt',
  'sentimental',
  'cosy',
  'cozy',
  'lively',
  'funky',
  'groovy',
  'sleek',
  'authoritative',
  'reassuring',
  'urgent',
  'celebratory',
  'festive',
  'moody',
  'atmospheric',
  'cinematic',
  'building',
  'reveal',
] as const;

const GENRES: Readonly<Record<string, string>> = {
  lofi: 'lo-fi',
  'lo fi': 'lo-fi',
  'hip hop': 'hip-hop',
  hiphop: 'hip-hop',
  electronic: 'electronic',
  pop: 'pop',
  rock: 'rock',
  acoustic: 'acoustic',
  jazz: 'jazz',
  classical: 'classical',
  orchestral: 'orchestral',
  ambient: 'ambient',
  house: 'house',
  'deep house': 'deep house',
  synthwave: 'synthwave',
  funk: 'funk',
  'r&b': 'R&B',
  rnb: 'R&B',
  soul: 'soul',
  folk: 'folk',
  piano: 'piano',
  afrobeats: 'afrobeats',
  afrobeat: 'afrobeats',
  amapiano: 'amapiano',
  reggae: 'reggae',
  latin: 'latin',
  edm: 'EDM',
  trap: 'trap',
  indie: 'indie',
  country: 'country',
  blues: 'blues',
  disco: 'disco',
  techno: 'techno',
  chillhop: 'chillhop',
  corporate: 'corporate',
  'drum and bass': 'drum and bass',
  dubstep: 'dubstep',
  gospel: 'gospel',
  garage: 'UK garage',
  grime: 'grime',
  cinematic: 'cinematic',
};

const ENERGY: Readonly<Record<string, string>> = {
  low: 'low energy',
  medium: 'medium energy',
  mid: 'medium energy',
  high: 'high energy',
  'high flat': 'steady high energy',
  rising: 'building energy',
  building: 'building energy',
  'low rising': 'building energy',
  steady: 'steady energy',
};

const TEMPO: Readonly<Record<string, string>> = {
  fast: 'fast tempo',
  slow: 'slow tempo',
  'mid tempo': 'mid tempo',
  midtempo: 'mid tempo',
  'fast paced': 'fast tempo',
};

const MOOD_SET: ReadonlySet<string> = new Set(MOODS);
const MAX_MOODS = 5;
const MAX_GENRES = 2;
const MIN_BPM = 60;
const MAX_BPM = 200;

export interface MusicPromptInput {
  /** VideoBrief.tone (Layer 1 output from the user's brief). */
  briefTone?: string | null;
  /** BrandKit.toneKeywords. */
  brandToneKeywords?: readonly string[];
  /** SlideshowTemplate.musicMood (A5.4). */
  slideshowMusicMood?: string | null;
  /** Library reference envelope (A3.6): TEMPLATE uses all of it, INSPIRE mood/genre only. */
  reference?: {
    mode: 'TEMPLATE' | 'INSPIRE';
    mood?: string | null;
    genre?: string | null;
    energy?: string | null;
    bpm?: number | null;
  } | null;
  /** 'short' = social short; 'long' = long-form. */
  format: 'short' | 'long';
}

export interface MusicPrompt {
  prompt: string;
  /** Stable key of the prompt (for reuse: same key + long enough track = same music). */
  key: string;
  descriptors: { moods: string[]; genres: string[]; energy: string | null; bpm: number | null };
}

function normalise(text: string | null | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9&\s]/g, ' ') // hyphens too: 'lo-fi' → 'lo fi'
    .replace(/\s+/g, ' ')
    .trim();
}

/** Vocabulary words present in the text, in order of first appearance, de-duplicated. */
export function extractMoods(text: string | null | undefined): string[] {
  const words = normalise(text).split(' ');
  return [...new Set(words.filter((w) => MOOD_SET.has(w)))];
}

export function extractGenres(text: string | null | undefined): string[] {
  const clean = ` ${normalise(text)} `;
  const found: Array<{ at: number; genre: string }> = [];
  for (const [term, genre] of Object.entries(GENRES)) {
    const at = clean.indexOf(` ${term} `);
    if (at >= 0) found.push({ at, genre });
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.genre))];
}

function lookup(table: Readonly<Record<string, string>>, text: string | null | undefined) {
  const clean = normalise(text);
  if (table[clean]) return table[clean];
  const word = clean.split(' ').find((w) => table[w]);
  return word ? (table[word] ?? null) : null;
}

export function buildMusicPrompt(input: MusicPromptInput): MusicPrompt {
  const ref = input.reference ?? null;
  const moodSources = [
    ref?.mood,
    input.slideshowMusicMood,
    input.briefTone,
    ...(input.brandToneKeywords ?? []),
  ];
  const moods = [...new Set(moodSources.flatMap((s) => extractMoods(s)))].slice(0, MAX_MOODS);
  const genres = [
    ...new Set([ref?.genre, ref?.mood, input.slideshowMusicMood].flatMap((s) => extractGenres(s))),
  ].slice(0, MAX_GENRES);
  // TEMPLATE follows the reference's structure, so its energy and tempo are used too;
  // INSPIRE takes only the vibe (A3.7).
  const energy =
    (ref?.mode === 'TEMPLATE' ? lookup(ENERGY, ref.energy) : null) ??
    lookup(TEMPO, input.slideshowMusicMood) ??
    null;
  const bpm =
    ref?.mode === 'TEMPLATE' &&
    typeof ref.bpm === 'number' &&
    Number.isFinite(ref.bpm) &&
    ref.bpm >= MIN_BPM &&
    ref.bpm <= MAX_BPM
      ? Math.round(ref.bpm)
      : null;

  const parts = [
    `Instrumental background music for a ${input.format === 'long' ? 'long-form online' : 'short social media'} video, no vocals.`,
    moods.length ? `Mood: ${moods.join(', ')}.` : 'Mood: warm, upbeat, friendly.',
    genres.length ? `Genre: ${genres.join(', ')}.` : null,
    energy ? `Energy: ${energy}.` : null,
    bpm ? `Tempo: around ${bpm} BPM.` : null,
    'Consistent, unobtrusive mix that sits under a voiceover, with a clean ending.',
  ].filter((p): p is string => p !== null);
  const prompt = parts.join(' ');
  return {
    prompt,
    key: createHash('sha256').update(prompt).digest('hex').slice(0, 32),
    descriptors: { moods, genres, energy, bpm },
  };
}
