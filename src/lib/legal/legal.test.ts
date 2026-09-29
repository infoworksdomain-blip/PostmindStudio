import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isLegalDoc,
  isPlaceholder,
  LEGAL_DOCS,
  legalContentDir,
  PLACEHOLDER_MARKER,
  readLegalDocument,
} from './documents';
import { legalReadiness, signupsOpen, signupsState } from './readiness';

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

  it('the repository ships placeholders for every document', async () => {
    const readiness = await legalReadiness(legalContentDir({}));
    expect(readiness.docs.every((d) => d.present && d.placeholder)).toBe(true);
    expect(isPlaceholder('real text')).toBe(false);
  });

  it('honours STUDIO_LEGAL_CONTENT_DIR', () => {
    expect(legalContentDir({ STUDIO_LEGAL_CONTENT_DIR: '/srv/legal' })).toBe('/srv/legal');
  });
});

describe('legal readiness gate', () => {
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
