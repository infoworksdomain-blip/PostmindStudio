// BACKLOG 20.18 — a gentle "add a little more detail" hint for short or generic briefs.
//
// Pure: no React, no server imports. Used by Create (video, slideshow topic, upload brief), the
// month-plan item brief and onboarding's first video. It never blocks submission; it only decides
// whether the hint is shown. Ideation (pipeline/ideation.ts) makes the real call and, since 20.18,
// picks a direction itself whenever the business profile gives it enough to work with.

/** Fewer meaningful words than this shows the hint. */
export const MIN_MEANINGFUL_WORDS = 4;

/**
 * Words that say "make me something" without saying what: filler, articles and the words for a
 * video / post / content in the UI languages. Lower-case, NFKC.
 */
const GENERIC_WORDS: ReadonlySet<string> = new Set([
  // English
  'a',
  'an',
  'the',
  'and',
  'of',
  'to',
  'for',
  'about',
  'on',
  'with',
  'in',
  'me',
  'i',
  'us',
  'we',
  'my',
  'our',
  'your',
  'please',
  'pls',
  'some',
  'something',
  'thing',
  'things',
  'stuff',
  'new',
  'nice',
  'good',
  'cool',
  'hi',
  'hello',
  'hey',
  'test',
  'make',
  'create',
  'do',
  'need',
  'want',
  'generate',
  'video',
  'videos',
  'post',
  'posts',
  'content',
  'clip',
  'clips',
  'reel',
  'reels',
  'short',
  'shorts',
  'slideshow',
  'slideshows',
  'slide',
  'slides',
  // French
  'un',
  'une',
  'le',
  'la',
  'les',
  'de',
  'des',
  'du',
  'pour',
  'sur',
  'faire',
  'créer',
  'vidéo',
  'vidéos',
  'contenu',
  'publication',
  // Spanish / Portuguese / Italian
  'una',
  'uno',
  'um',
  'uma',
  'el',
  'los',
  'las',
  'o',
  'os',
  'as',
  'il',
  'lo',
  'gli',
  'para',
  'per',
  'sobre',
  'su',
  'hacer',
  'crear',
  'fazer',
  'criar',
  'fare',
  'creare',
  'vídeo',
  'vídeos',
  'contenido',
  'conteúdo',
  'contenuto',
  'publicación',
  'publicação',
  // German
  'ein',
  'eine',
  'einen',
  'das',
  'der',
  'die',
  'für',
  'über',
  'machen',
  'erstellen',
  'inhalt',
  'beitrag',
  // Hindi
  'एक',
  'के',
  'लिए',
  'का',
  'की',
  'वीडियो',
  'बनाओ',
  'बनाएं',
  'बनाइए',
  'पोस्ट',
  // Arabic
  'عن',
  'من',
  'فيديو',
  'منشور',
  'محتوى',
  'اصنع',
  'أنشئ',
]);

/** Generic phrases in scripts written without spaces (removed before counting). */
const GENERIC_CJK = ['视频', '帖子', '内容', '制作', '一个', '一条', '给我', '请', '做'];

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}';
const TOKEN = new RegExp(
  `[${CJK}]+|(?:(?![${CJK}])[\\p{L}\\p{M}\\p{N}])+(?:['’-](?:(?![${CJK}])[\\p{L}\\p{M}\\p{N}])+)*`,
  'gu',
);
const CJK_RUN = new RegExp(`^[${CJK}]+$`, 'u');
/** Chinese and Japanese words average about two characters. */
const CJK_CHARS_PER_WORD = 2;

/**
 * How many words in the brief say something specific. Text in scripts without spaces (Chinese,
 * Japanese) is counted by characters, so a full sentence there is never "too short".
 */
export function meaningfulWordCount(text: string): number {
  let rest = text.normalize('NFKC').toLocaleLowerCase();
  for (const phrase of GENERIC_CJK) rest = rest.split(phrase).join(' ');
  let count = 0;
  for (const token of rest.match(TOKEN) ?? []) {
    if (CJK_RUN.test(token)) count += Math.ceil([...token].length / CJK_CHARS_PER_WORD);
    else if (!GENERIC_WORDS.has(token) && ([...token].length > 1 || /\p{N}/u.test(token)))
      count += 1;
  }
  return count;
}

/**
 * True when a typed brief is short or generic enough to deserve the hint. An empty brief is not
 * "vague" here (nothing typed yet, or the field is optional).
 */
export function isVagueBrief(text: string | null | undefined): boolean {
  if (!text?.trim()) return false;
  return meaningfulWordCount(text) < MIN_MEANINGFUL_WORDS;
}
