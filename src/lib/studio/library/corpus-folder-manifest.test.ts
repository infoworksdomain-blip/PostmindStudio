import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkManifest, compareWithUploadList, formatManifestCheck } from './corpus-folder-check';
import {
  categoryFromPath,
  categoryIndex,
  csvField,
  kebabCase,
  languageFromPath,
  MANIFEST_COLUMNS,
  manifestCsv,
  manifestRow,
  platformFromPath,
  sourceRefFor,
  tagsFromPath,
  titleFromFileName,
} from './corpus-folder-manifest';
import { parseCsv } from './corpus-manifest';
import { taxonomyFile } from './taxonomy';

const ROOT = join(__dirname, '..', '..', '..', '..');
const taxonomy = taxonomyFile.parse(
  JSON.parse(readFileSync(join(ROOT, 'prisma', 'data', 'library-taxonomy.json'), 'utf8')),
);
const categories = categoryIndex(taxonomy.categories);

describe('the manifest format is exactly the template', () => {
  it('uses the header of corpus/manifest.template.csv', () => {
    const template = readFileSync(join(ROOT, 'corpus', 'manifest.template.csv'), 'utf8');
    expect(parseCsv(template)[0]).toEqual([...MANIFEST_COLUMNS]);
    expect(manifestCsv([]).split('\n')[0]).toBe(MANIFEST_COLUMNS.join(','));
  });
});

describe('titleFromFileName', () => {
  it.each([
    ['a/b/morning_run-routine.mp4', 'Morning run routine'],
    ['BAKERY__Behind-the-Scenes.MOV', 'BAKERY behind the scenes'],
    ['DIY shelf UK edition.webm', 'DIY shelf UK edition'],
    ['x/  spaced -- out__name .mp4', 'Spaced out name'],
    ['no-extension', 'No extension'],
    ['v2.final.mp4', 'V2.final'],
    ['été_à_Paris.mp4', 'Été à paris'],
  ])('%s → %s', (path, title) => {
    expect(titleFromFileName(path)).toBe(title);
  });

  it('caps the title at 200 characters', () => {
    expect(titleFromFileName(`${'a'.repeat(300)}.mp4`)).toHaveLength(200);
  });
});

describe('tagsFromPath', () => {
  it('kebab-cases every parent folder, de-duplicated, in order', () => {
    expect(tagsFromPath('Lifestyle/Behind The Scenes!/Café Vidéos/clip.mp4')).toEqual([
      'lifestyle',
      'behind-the-scenes',
      'cafe-videos',
    ]);
    expect(tagsFromPath('Food/food/FOOD/x.mp4')).toEqual(['food']);
    expect(tagsFromPath('clip.mp4')).toEqual([]);
    expect(tagsFromPath('!!!/clip.mp4')).toEqual([]);
  });

  it('keeps letters of any script and limits count and length', () => {
    expect(kebabCase('日本 動画')).toBe('日本-動画');
    const deep = `${Array.from({ length: 25 }, (_, i) => `f${i}`).join('/')}/clip.mp4`;
    expect(tagsFromPath(deep)).toHaveLength(20);
    expect(tagsFromPath(`${'long '.repeat(20)}/clip.mp4`)[0]?.length).toBeLessThanOrEqual(60);
    expect(tagsFromPath(`${'long '.repeat(20)}/clip.mp4`)[0]).not.toMatch(/-$/);
  });
});

describe('categoryFromPath (taxonomy seed prisma/data/library-taxonomy.json)', () => {
  it.each([
    ['Lifestyle/clip.mp4', 'lifestyle'],
    ['lifestyle/Fitness/clip.mp4', 'lifestyle/fitness'],
    ['Lifestyle/Not A Category/clip.mp4', 'lifestyle'],
    ['News and commentary/x.mp4', 'news-and-commentary'],
    ['Fitness/clip.mp4', 'lifestyle/fitness'],
    ['Product marketing/Feature demo/x.mp4', 'product-marketing/feature-demo'],
    ['Random/Lifestyle/clip.mp4', ''],
    ['clip.mp4', ''],
  ])('%s → "%s"', (path, category) => {
    expect(categoryFromPath(path, categories)).toBe(category);
  });
});

describe('languageFromPath', () => {
  it.each([
    ['French/clip.mp4', 'fr'],
    ['videos/pt-BR/clip.mp4', 'pt-BR'],
    ['Español/clip.mp4', 'es'],
    ['clip (Spanish).mp4', 'es'],
    ['clip [en].mp4', 'en'],
    ['French toast recipe.mp4', ''],
    ['Food/French toast/clip.mp4', ''],
    ['French/clip (German).mp4', ''],
    ['do-it-yourself.mp4', ''],
  ])('%s → "%s"', (path, lang) => {
    expect(languageFromPath(path)).toBe(lang);
  });
});

describe('platformFromPath', () => {
  it.each([
    ['TikTok/clip.mp4', 'tiktok'],
    ['exports/Instagram Reels/clip.mp4', 'instagram'],
    ['yt/clip_from_YOUTUBE.mp4', 'youtube'],
    ['Tik Tok/clip.mp4', 'tiktok'],
    ['tiktok/instagram-repost.mp4', ''],
    ['misc/clip.mp4', ''],
  ])('%s → "%s"', (path, platform) => {
    expect(platformFromPath(path)).toBe(platform);
  });
});

describe('sourceRef and url', () => {
  it('is stable per relative path and differs between paths', () => {
    expect(sourceRefFor('a/b.mp4')).toBe(sourceRefFor('a/b.mp4'));
    expect(sourceRefFor('a/b.mp4')).not.toBe(sourceRefFor('a/c.mp4'));
    expect(sourceRefFor('a/b.mp4')).toMatch(/^corpus-[0-9a-f]{20}$/);
  });

  it('builds s3://bucket/prefix/<relative path>', () => {
    const row = manifestRow(
      { relPath: 'Lifestyle/Fitness/TikTok/Morning_run.mp4', size: 1 },
      { bucket: 'eu-corpus-source', prefix: 'videos/', categories },
    );
    expect(row).toEqual({
      url: 's3://eu-corpus-source/videos/Lifestyle/Fitness/TikTok/Morning_run.mp4',
      title: 'Morning run',
      tags: ['lifestyle', 'fitness', 'tiktok'],
      category: 'lifestyle/fitness',
      sourceRef: sourceRefFor('Lifestyle/Fitness/TikTok/Morning_run.mp4'),
      language: '',
      sourcePlatform: 'tiktok',
    });
  });
});

describe('CSV output passes the real manifest validator', () => {
  const opts = { bucket: 'eu-corpus-source', prefix: 'videos/', categories };
  const paths = [
    'Lifestyle/Fitness/clip, with comma.mp4',
    'Business/"quoted" name.mp4',
    'Community/ leading space.mp4',
    'Café/été #1 & co.mp4',
    'plain.mp4',
  ];

  it('quotes fields that need it', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField(' x')).toBe('" x"');
    expect(csvField('plain')).toBe('plain');
  });

  it('round-trips through parseManifest + validateRows with no rejected rows', () => {
    const rows = paths.map((relPath) => manifestRow({ relPath, size: 1 }, opts));
    const check = checkManifest(manifestCsv(rows), categories.slugs);
    expect(check.errors).toEqual([]);
    expect(check.valid).toBe(paths.length);
    expect(check.distribution).toEqual([
      ['(auto)', 2],
      ['business', 1],
      ['community', 1],
      ['lifestyle', 1],
    ]);
    expect(formatManifestCheck(check)).toContain('5 of 5 rows valid');
  });

  it('reports rows the validator rejects', () => {
    const good = manifestRow({ relPath: 'a.mp4', size: 1 }, opts);
    const csv = manifestCsv([good, good, { ...good, sourceRef: 'x', category: 'no-such-slug' }]);
    const check = checkManifest(csv, categories.slugs);
    expect(check.errors.map((e) => e.error)).toEqual([
      'duplicate of line 2',
      'unknown category slug "no-such-slug"',
    ]);
    expect(formatManifestCheck(check)).toContain('Rejected rows (2)');
  });
});

describe('compareWithUploadList', () => {
  it('finds rows not uploaded and uploads without a row', () => {
    expect(compareWithUploadList(['a', 'b'], ['b', 'c'])).toEqual({
      notUploaded: ['a'],
      notInManifest: ['c'],
    });
  });
});
