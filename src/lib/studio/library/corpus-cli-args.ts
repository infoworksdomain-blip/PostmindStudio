import { isAbsolute, relative, resolve } from 'node:path';
import { StudioError, ValidationError } from '../../errors';
import { logger } from '../../logger';

// Phase 19 Track 1 — argument parsing shared by the scripts/corpus/*.ts tools (pure; tested).

export interface ParsedArgs {
  positional: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

/**
 * Parses `<positional…> --flag --option value`. `valueOptions` take a value, `flagOptions` do
 * not; anything else starting with -- is refused so a typo never silently changes a run.
 */
export function parseArgs(
  argv: readonly string[],
  spec: { valueOptions: readonly string[]; flagOptions: readonly string[] },
): ParsedArgs {
  const out: ParsedArgs = { positional: [], flags: new Set(), values: new Map() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (spec.flagOptions.includes(arg)) out.flags.add(arg);
    else if (spec.valueOptions.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new ValidationError(`${arg} needs a value`);
      out.values.set(arg, value);
      i += 1;
    } else if (arg.startsWith('--')) throw new ValidationError(`unknown option ${arg}`);
    else out.positional.push(arg);
  }
  return out;
}

/** "mkv, .M4V" → ["mkv", "m4v"]. */
export function listOption(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** True when `path` is `folder` itself or inside it. */
export function isInside(folder: string, path: string): boolean {
  const rel = relative(resolve(folder), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Output files must not land inside the scanned folder (the tools never change it). */
export function assertOutside(folder: string, file: string): void {
  if (isInside(folder, file)) throw new ValidationError(`Write ${file} outside the video folder`);
}

/** Ends a CLI run: a plain one-line reason on stderr (for the operator) plus the structured log. */
export function failCli(tool: string, err: unknown): never {
  const known = err instanceof StudioError;
  const reason = known ? err.message : 'unexpected error (details below)';
  process.stderr.write(`\n${tool}: ${reason}\n`);
  logger.error({ err }, `${tool} failed`);
  process.exit(1);
}
