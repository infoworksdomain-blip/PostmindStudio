import { statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  uploadListText,
} from '../../src/lib/studio/library/corpus-folder';
import {
  buildScanReport,
  formatScanSummary,
} from '../../src/lib/studio/library/corpus-folder-report';
import { scanFolder, uploadSelection } from '../../src/lib/studio/library/corpus-folder-scan';

// Phase 19 Track 1 — look at the corpus folder before uploading it (runbooks/corpus-upload.md).
// Read-only: it never changes, moves or renames anything in the folder, and refuses to write its
// own output files inside it.
//
//   npm run corpus:scan -- "D:\Videos" [--out scan.json] [--upload-list corpus-files.txt]
//     [--skip-duplicates] [--also-accept mkv,m4v] [--prefix videos/]
//
// --upload-list writes the exact list of files the upload copies (scripts/corpus/upload.ps1
// -FilesFrom); manifest-from-folder.ts with the same options lists the same files.

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), {
    valueOptions: ['--out', '--upload-list', '--also-accept', '--prefix'],
    flagOptions: ['--skip-duplicates'],
  });
  const folder = args.positional[0];
  if (!folder || args.positional.length > 1)
    throw new ValidationError(
      'usage: scan-folder.ts <folder> [--out report.json] [--upload-list files.txt] …',
    );
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory())
    throw new ValidationError(`${folder} is not a folder`);
  const outPath = args.values.get('--out');
  const listPath = args.values.get('--upload-list');
  for (const file of [outPath, listPath]) if (file) assertOutside(folder, file);
  const skipDuplicates = args.flags.has('--skip-duplicates');

  out(`Scanning ${resolve(folder)} (read-only)…`);
  const scan = await scanFolder(resolve(folder), {
    accepted: acceptedExtensions(listOption(args.values.get('--also-accept'))),
    keyPrefix: normalisePrefix(args.values.get('--prefix') ?? 'videos/'),
  });
  const upload = uploadSelection(scan, skipDuplicates);
  const report = buildScanReport(scan, upload, { skipDuplicates });
  out(formatScanSummary(report));
  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    out(`\nFull report: ${resolve(outPath)}`);
  }
  if (listPath) {
    writeFileSync(listPath, uploadListText(upload));
    out(`Upload list (${upload.length} files): ${resolve(listPath)}`);
  }
}

main().catch((err: unknown) => failCli('scan-folder', err));
