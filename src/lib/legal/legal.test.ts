import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isLegalDoc,
  isPlaceholder,
  LEGAL_DOCS,
  legalContentDir,
  legalTextState,
  PLACEHOLDER_MARKER,
  readLegalDocument,
  unfilledMarkers,
} from './documents';
import { legalReadiness, signupsOpen, signupsState, unfilledAcross } from './readiness';

// Phase 18 §3 legal pages and the legal-readiness launch gate.

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-legal-'));
  await mkdir(join(dir, 'en-GB'));
  await mkdir(join(dir, 'fr'));
  for (const doc of LEGAL_DOCS)
    await writeFile(join(dir, 'en-GB', `${doc}.md`), `<!-- ${PLACEHOLDER_MARKER} -->\n# ${doc}`);
  await writeFile(join(dir, 'fr', 'terms.md'), '# Conditions générales\n\nTexte réel.');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('legal documents', () => {
  it('knows the six documents', () => {
    expect(LEGAL_DOCS).toHaveLength(6);
    expect(isLegalDoc('dpa')).toBe(true);
    expect(isLegalDoc('../etc/passwd')).toBe(false);
  });

  it('reads the reader’s locale when present', async () => {
    const doc = await readLegalDocument('terms', 'fr', dir);
    expect(doc).toMatchObject({ locale: 'fr', fallback: false, placeholder: false });
  });

  it('falls back to en-GB with a note when the locale has no file', async () => {
    const doc = await readLegalDocument('privacy', 'fr', dir);
    expect(doc).toMatchObject({ locale: 'en-GB', fallback: true, placeholder: true });
    const unknown = await readLegalDocument('privacy', 'xx', dir);
    expect(unknown).toMatchObject({ locale: 'en-GB', fallback: false });
  });

  it('answers null when even en-GB is missing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'studio-legal-empty-'));
    expect(await readLegalDocument('terms', 'en-GB', empty)).toBeNull();
    await rm(empty, { recursive: true, force: true });
  });

  it('the repository ships drafts with fill-in markers for every document', async () => {
    const readiness = await legalReadiness(legalContentDir({}));
    expect(readiness.docs.every((d) => d.present && d.placeholder)).toBe(true);
    expect(readiness.docs.every((d) => d.state === 'fill_in')).toBe(true);
    expect(readiness.launchBlockers).toEqual(['terms', 'privacy']);
    expect(unfilledAcross(readiness)).toEqual(
      expect.arrayContaining(['[[COMPANY LEGAL NAME]]', '[[CONTACT EMAIL]]']),
    );
    expect(isPlaceholder('real text')).toBe(false);
  });

  it('the drafts link only to the legal pages, pricing, https and mailto', async () => {
    const allowed =
      /^(https:\/\/|mailto:|\/pricing$|\/legal\/(terms|privacy|cookies|acceptable-use|dpa|subprocessors)(#[a-z0-9-]+)?$|#[a-z0-9-]+$)/;
    for (const doc of LEGAL_DOCS) {
      const found = await readLegalDocument(doc, 'en-GB', legalContentDir({}));
      expect(found?.markdown).not.toContain(PLACEHOLDER_MARKER);
      for (const [, href] of found!.markdown.matchAll(/\]\(([^)\s]+)\)/g))
        expect(href).toMatch(allowed);
    }
  });

  it('honours STUDIO_LEGAL_CONTENT_DIR', () => {
    expect(legalContentDir({ STUDIO_LEGAL_CONTENT_DIR: '/srv/legal' })).toBe('/srv/legal');
  });
});

describe('fill-in markers', () => {
  it('lists each distinct [[…]] marker once, in order', () => {
    const text = '[[COMPANY LEGAL NAME]] of [[REGISTERED ADDRESS]]; [[COMPANY LEGAL NAME]] again';
    expect(unfilledMarkers(text)).toEqual(['[[COMPANY LEGAL NAME]]', '[[REGISTERED ADDRESS]]']);
  });

  it('ignores single brackets, links, empty and line-split markers', () => {
    expect(unfilledMarkers('[a link](/legal/dpa) and [note] and [[\nX]]')).toEqual([]);
    expect(unfilledMarkers('[[]]')).toEqual([]);
  });

  it('a draft with markers is not ready; the placeholder marker wins', () => {
    expect(legalTextState('Contact [[CONTACT EMAIL]].')).toBe('fill_in');
    expect(isPlaceholder('Contact [[CONTACT EMAIL]].')).toBe(true);
    expect(legalTextState(`${PLACEHOLDER_MARKER} [[CONTACT EMAIL]]`)).toBe('placeholder');
    expect(legalTextState('Contact legal@example.com.')).toBe('ready');
  });

  it('readLegalDocument reports the draft state', async () => {
    const drafts = await mkdtemp(join(tmpdir(), 'studio-legal-drafts-'));
    await mkdir(join(drafts, 'en-GB'));
    await writeFile(join(drafts, 'en-GB', 'terms.md'), '# Terms\n\n[[COMPANY LEGAL NAME]]');
    expect(await readLegalDocument('terms', 'en-GB', drafts)).toMatchObject({
      placeholder: true,
      state: 'fill_in',
    });
    await rm(drafts, { recursive: true, force: true });
  });
});

describe('legal readiness gate', () => {
  it('unfilled markers in terms or privacy block launch, with the markers listed', async () => {
    const drafts = await mkdtemp(join(tmpdir(), 'studio-legal-fill-'));
    await mkdir(join(drafts, 'en-GB'));
    for (const doc of LEGAL_DOCS)
      await writeFile(
        join(drafts, 'en-GB', `${doc}.md`),
        doc === 'privacy' ? '# Privacy\n\nWrite to [[PRIVACY EMAIL]].' : `# ${doc}`,
      );
    const readiness = await legalReadiness(drafts);
    expect(readiness).toMatchObject({ ready: false, launchBlockers: ['privacy'] });
    expect(readiness.docs.find((d) => d.doc === 'privacy')).toMatchObject({
      present: true,
      placeholder: true,
      state: 'fill_in',
      unfilled: ['[[PRIVACY EMAIL]]'],
    });
    expect(readiness.docs.find((d) => d.doc === 'terms')).toMatchObject({
      state: 'ready',
      unfilled: [],
    });
    expect(signupsState(readiness, { NODE_ENV: 'production' })).toEqual({
      open: false,
      reason: 'legal_placeholder',
    });
    await rm(drafts, { recursive: true, force: true });
  });

  it('blocks launch while terms or privacy is the placeholder', async () => {
    const readiness = await legalReadiness(dir);
    expect(readiness).toMatchObject({ ready: false, launchBlockers: ['terms', 'privacy'] });
  });

  it('missing files block too', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'studio-legal-none-'));
    const readiness = await legalReadiness(empty);
    expect(readiness.docs.every((d) => !d.present)).toBe(true);
    expect(readiness.launchBlockers).toEqual(['terms', 'privacy']);
    await rm(empty, { recursive: true, force: true });
  });

  it('only terms and privacy block sign-up; the rest only warn', async () => {
    const partial = await mkdtemp(join(tmpdir(), 'studio-legal-partial-'));
    await mkdir(join(partial, 'en-GB'));
    for (const doc of LEGAL_DOCS)
      await writeFile(
        join(partial, 'en-GB', `${doc}.md`),
        doc === 'dpa' ? PLACEHOLDER_MARKER : `# ${doc}`,
      );
    const readiness = await legalReadiness(partial);
    expect(readiness).toMatchObject({ ready: false, launchBlockers: [] });
    await rm(partial, { recursive: true, force: true });
  });

  it('production sign-up stays closed until the blockers are gone', () => {
    const blocked = { launchBlockers: ['terms' as const] };
    expect(signupsState(blocked, { NODE_ENV: 'production' })).toEqual({
      open: false,
      reason: 'legal_placeholder',
    });
    expect(signupsState({ launchBlockers: [] }, { NODE_ENV: 'production' })).toEqual({
      open: true,
    });
    expect(signupsState(blocked, { NODE_ENV: 'development' })).toEqual({ open: true });
  });

  it('STUDIO_SIGNUPS_ENABLED=false closes sign-up (invite-only)', () => {
    expect(signupsState({ launchBlockers: [] }, { STUDIO_SIGNUPS_ENABLED: 'FALSE' })).toEqual({
      open: false,
      reason: 'disabled',
    });
  });

  it('signupsOpen reads the configured directory', async () => {
    expect(await signupsOpen({ NODE_ENV: 'production', STUDIO_LEGAL_CONTENT_DIR: dir })).toEqual({
      open: false,
      reason: 'legal_placeholder',
    });
  });
});
