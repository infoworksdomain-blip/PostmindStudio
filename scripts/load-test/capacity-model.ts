// T23 queue-capacity model: prints the before/after Markdown table for runbooks/load-testing.md.
// npx tsx scripts/load-test/capacity-model.ts [--orgs 100] [--render 3] [--orchestration 4]
//   [--assets 8] [--window-hours 72] [--immediate 3] [--no-callbacks]
// Deterministic and offline (no Redis, no database, no providers): same flags, same numbers.

import {
  afterScenario,
  beforeScenario,
  renderCapacityMarkdown,
  runCapacityScenario,
} from '../../src/lib/studio/load-test/capacity-model';

const NUMERIC_FLAGS = [
  '--orgs',
  '--render',
  '--orchestration',
  '--assets',
  '--window-hours',
  '--immediate',
] as const;

function numberFlag(args: readonly string[], flag: (typeof NUMERIC_FLAGS)[number]) {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const value = Number(args[at + 1]);
  if (!Number.isFinite(value) || value < 0) {
    process.stderr.write(`${flag} needs a non-negative number\n`);
    process.exit(1);
  }
  return value;
}

function main(): void {
  const args = process.argv.slice(2);
  const known = new Set<string>([...NUMERIC_FLAGS, '--no-callbacks']);
  const unknown = args.filter((a) => a.startsWith('--') && !known.has(a));
  if (unknown.length > 0) {
    process.stderr.write(`Unknown flag(s): ${unknown.join(', ')}\n`);
    process.exit(1);
  }
  const orgs = numberFlag(args, '--orgs') ?? 100;
  const orchestration = numberFlag(args, '--orchestration') ?? 4;
  const assets = numberFlag(args, '--assets') ?? 8;
  const render = numberFlag(args, '--render') ?? 3;

  const before = beforeScenario({
    organisations: orgs,
    lanes: { orchestration, assets, render: 0 },
  });
  const after = afterScenario({
    organisations: orgs,
    lanes: { orchestration, assets, render },
    leadWindowHours: numberFlag(args, '--window-hours') ?? 72,
    immediateItems: numberFlag(args, '--immediate') ?? 3,
    callbacks: !args.includes('--no-callbacks'),
  });

  const started = Date.now();
  const results = [runCapacityScenario(before), runCapacityScenario(after)];
  process.stdout.write(
    `### Queue capacity model: ${orgs} organisations each approve a ${before.days}-day plan ` +
      `(${before.postsPerDay}/day) at once\n\n`,
  );
  process.stdout.write(renderCapacityMarkdown(results));
  process.stdout.write(`\n_Simulated in ${Date.now() - started} ms (virtual time)._\n`);
}

main();
