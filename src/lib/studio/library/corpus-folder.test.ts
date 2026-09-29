import { describe, expect, it } from 'vitest';
import {
  acceptedExtensions,
  classifyFile,
  DEFAULT_ACCEPTED_EXTENSIONS,
  duplicateGroups,
  extensionOf,
  laterCopies,
  MAX_SOURCE_BYTES,
  nameProblems,
  nameWarnings,
  normalisePrefix,
  parseUploadList,
  selectUploadFiles,
  sizeCollisions,
  uploadListText,
} from './corpus-folder';
import { UPLOAD_VIDEO_EXTENSION } from '../services/uploads';

const accepted = acceptedExtensions();
const classify = (relPath: string, size = 1_000, keyPrefix = 'videos/') =>
  classifyFile({ relPath, size }, { accepted, keyPrefix });

describe('accepted formats and limits come from the ingest code', () => {
  it('accepts exactly the video upload extensions (mp4, mov, webm)', () => {
    expect([...DEFAULT_ACCEPTED_EXTENSIONS].sort()).toEqual(
      Object.values(UPLOAD_VIDEO_EXTENSION).sort(),
    );
    expect([...accepted].sort()).toEqual(['mov', 'mp4', 'webm']);
  });

  it('adds --also-accept extras, case- and dot-insensitive', () => {
    expect([...acceptedExtensions(['.MKV', ' m4v ', ''])].sort()).toEqual([
      'm4v',
      'mkv',
      'mov',
      'mp4',
      'webm',
    ]);
  });

  it('uses the ingest 200 MiB cap: equal passes, one byte more is refused', () => {
    expect(MAX_SOURCE_BYTES).toBe(200 * 1024 * 1024);
    expect(classify('a.mp4', MAX_SOURCE_BYTES).reject).toEqual([]);
    expect(classify('a.mp4', MAX_SOURCE_BYTES + 1).reject).toEqual(['too-large']);
  });
});

describe('classifyFile', () => {
  it('accepts upper-case extensions', () => {
    expect(extensionOf('dir/Clip.MOV')).toBe('mov');
    expect(classify('dir/Clip.MOV').reject).toEqual([]);
  });

  it('refuses empty files, other formats, files without extension and system files', () => {
    expect(classify('a.mp4', 0).reject).toEqual(['empty']);
    expect(classify('notes.txt').reject).toEqual(['unsupported-format']);
    expect(classify('README').reject).toEqual(['unsupported-format']);
    expect(extensionOf('.hidden')).toBe('');
    expect(classify('x/Thumbs.db').reject).toEqual(['system-file']);
    expect(classify('x/._clip.mp4').reject).toEqual(['system-file']);
    expect(classify('desktop.ini').reject).toEqual(['system-file']);
  });

  it('refuses names rclone would store under a different key', () => {
    expect(classify('odd？name.mp4').reject).toEqual(['bad-name']);
    expect(classify('a＜b＞.mp4').reject).toEqual(['bad-name']);
    expect(classify('tab\there.mp4').reject).toEqual(['bad-name']);
    expect(classify('folder. /clip.mp4').reject).toEqual(['bad-name']);
    expect(classify('pic␀.mp4').reject).toEqual(['bad-name']);
    expect(nameProblems('lone\ud800.mp4')).toContain('is not valid Unicode');
  });

  it('refuses keys longer than 1,024 bytes including the prefix', () => {
    const name = `${'é'.repeat(508)}.mp4`; // 1,016 + 4 bytes
    expect(classify(name, 10, '').reject).toEqual([]);
    expect(classify(name, 10, 'videos/').reject).toEqual(['key-too-long']);
  });

  it('warns about names that still upload fine', () => {
    expect(classify('Café/été #1 & co.mp4').reject).toEqual([]);
    expect(nameWarnings('Café/été #1 & co.mp4')).toEqual([
      'non-English letters or symbols',
      'contains # % + or &',
    ]);
    expect(nameWarnings(' lead/two  spaces.mp4')).toEqual(['leading or double spaces']);
    expect(nameWarnings('plain/name.mp4')).toEqual([]);
  });
});

describe('normalisePrefix', () => {
  it('always ends in one slash, or is empty', () => {
    expect(normalisePrefix('videos/')).toBe('videos/');
    expect(normalisePrefix('/videos')).toBe('videos/');
    expect(normalisePrefix('a\\b\\')).toBe('a/b/');
    expect(normalisePrefix('  ')).toBe('');
  });
});

describe('duplicates and the upload selection', () => {
  const files = [
    { relPath: 'b/copy.mp4', size: 10, quickHash: 'h1' },
    { relPath: 'a/orig.mp4', size: 10, quickHash: 'h1' },
    { relPath: 'c/same-size.mp4', size: 10, quickHash: 'h2' },
    { relPath: 'd/other.mp4', size: 20, quickHash: 'h1' },
  ];

  it('only size collisions need hashing', () => {
    expect(sizeCollisions(files).map((f) => f.relPath)).toEqual([
      'b/copy.mp4',
      'a/orig.mp4',
      'c/same-size.mp4',
    ]);
  });

  it('groups files with the same size and quick hash', () => {
    expect(duplicateGroups(files)).toEqual([['a/orig.mp4', 'b/copy.mp4']]);
    expect([...laterCopies(duplicateGroups(files))]).toEqual(['b/copy.mp4']);
  });

  it('selects accepted files in path order, dropping later copies only when asked', () => {
    const verdicts = [
      classify('b/copy.mp4', 10),
      classify('a/orig.mp4', 10),
      classify('z/notes.txt', 10),
    ];
    const duplicates = [['a/orig.mp4', 'b/copy.mp4']];
    expect(
      selectUploadFiles(verdicts, { duplicates, skipDuplicates: false }).map((f) => f.relPath),
    ).toEqual(['a/orig.mp4', 'b/copy.mp4']);
    expect(
      selectUploadFiles(verdicts, { duplicates, skipDuplicates: true }).map((f) => f.relPath),
    ).toEqual(['a/orig.mp4']);
  });

  it('writes and reads the upload list (LF, no BOM; CRLF and BOM tolerated)', () => {
    const text = uploadListText([
      { relPath: 'a b/c.mp4', size: 1 },
      { relPath: 'd.mp4', size: 1 },
    ]);
    expect(text).toBe('a b/c.mp4\nd.mp4\n');
    expect(parseUploadList(text)).toEqual(['a b/c.mp4', 'd.mp4']);
    expect(parseUploadList('﻿a.mp4\r\nb.mp4\r\n')).toEqual(['a.mp4', 'b.mp4']);
  });
});
