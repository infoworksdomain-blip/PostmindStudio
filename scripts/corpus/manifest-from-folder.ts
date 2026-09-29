import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ValidationError } from '../../src/lib/errors';
import {
  assertOutside,
  failCli,
  listOption,
  parseArgs,
} from '../../src/lib/studio/library/corpus-cli-args';
import {
  acceptedExtensions,
  normalisePrefix,
  parseUploadList,
} from '../../src/lib/studio/library/corpus-folder';
import {
  categoryIndex,
  manifestCsv,
  manifestRow,
} from '../../src/lib/studio/library/corpus-folder-manifest';
import { scanFolder, uploadSelection } from '../../src/lib/studio/library/corpus-folder-scan';
import {
  checkManifest,
  compareWithUploadList,
  formatManifestCheck,
} from '../../src/lib/studio/library/corpus-folder-check';
import { taxonomyFile } from '../../src/lib/studio/library/taxonomy';

// Phase 19 Track 1 — write the corpus manifest (corpus/manifest.template.csv format) from the
// folder that was uploaded (runbooks/corpus-upload.md). Read-only on the folder.
//
//   npm run corpus:manifest -- "D:\Videos" --bucket eu-corpus-source --prefix videos/
//     [--out corpus.csv] [--upload-list corpus-files.txt] [--skip-duplicates]
//     [--also-accept mkv,m4v] [--taxonomy prisma/data/library-taxonomy.json]
//
// Use the same --skip-duplicates / --also-accept as the scan that wrote the upload list, and pass
// that list with --upload-list: the tool then proves every row is a file that was uploaded.

const DEFAULT_TAXONOMY = join(__dirname, '..', '..', 'prisma', 'data', 'library-taxonomy.json');

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function loadTaxonomy(path: string) {
  const parsed = taxonomyFile.safeParse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (!parsed.success) throw new ValidationError(`${path} is not a library taxonomy file`);
  return categoryIndex(parsed.data.categories);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), {
    valueOptions: ['--bucket', '--prefix', '--out', '--upload-list', '--also-accept', '--taxonomy'],
    flagOptions: ['--skip-duplicates'],
  });
  const folder = args.positional[0];
  const bucket = args.values.get('--bucket');
  const prefixArg = args.values.get('--prefix');
  if (!folder || args.positional.length > 1 || !bucket || prefixArg === undefined)
    throw new ValidationError(
      'usage: manifest-from-folder.ts <folder> --bucket <bucket> --prefix <prefix/> [--out corpus.csv] …',
    );
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory())
    throw new ValidationError(`${folder} is not a folder`);
  const outPath = args.values.get('--out') ?? 'corpus.csv';
  assertOutside(folder, outPath);
  const prefix = normalisePrefix(prefixArg);
  const categories = loadTaxonomy(args.values.get('--taxonomy') ?? DEFAULT_TAXONOMY);

  out(`Reading ${resolve(folder)} (read-only)…`);
  const scan = await scanFolder(resolve(folder), {
    accepted: acceptedExtensions(listOption(args.values.get('--also-accept'))),
    keyPrefix: prefix,
  });
  const files = uploadSelection(scan, args.flags.has('--skip-duplicates'));
  const rows = files.map((f) => manifestRow(f, { bucket, prefix, categories }));
  const csv = manifestCsv(rows);
  writeFileSync(outPath, csv);
  out(`Wrote ${rows.length} rows to ${resolve(outPath)}.`);
  const leftOut = scan.verdicts.length - files.length;
  if (leftOut > 0)
    out(
      `${leftOut} files are not in the manifest (refused or duplicate): run corpus:scan for the list.`,
    );

  // The real validator (ingest-corpus.ts uses it) on the file as written.
  const check = checkManifest(csv, categories.slugs);
  out(formatManifestCheck(check));
  let ok = check.errors.length === 0;

  const listPath = args.values.get('--upload-list');
  if (listPath) {
    const diff = compareWithUploadList(
      files.map((f) => f.relPath),
      parseUploadList(readFileSync(listPath, 'utf8')),
    );
    if (diff.notUploaded.length === 0 && diff.notInManifest.length === 0)
      out(`Every row matches a file in the upload list ${listPath}.`);
    else {
      ok = false;
      out(
        `The manifest and the upload list differ: ${diff.notUploaded.length} rows were not in the upload,` +
          ` ${diff.notInManifest.length} uploaded files have no row. Did the folder or the options change?`,
      );
      for (const p of diff.notUploaded.slice(0, 20)) out(`    not uploaded: ${p}`);
      for (const p of diff.notInManifest.slice(0, 20)) out(`    no row:       ${p}`);
    }
  }
  if (!ok) process.exitCode = 1;
}

main().catch((err: unknown) => failCli('manifest-from-folder', err));
