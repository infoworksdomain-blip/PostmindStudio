import { logger } from '../../src/lib/logger';
import {
  formatContractReport,
  parseContractArgs,
  runCoreContract,
} from '../../src/lib/studio/ops/core-contract';

// BACKLOG 14.10 — Core ↔ Studio internal API contract suite, run by the Core team against
// Studio STAGING (never production: it registers, refreshes, disconnects and purges a synthetic
// organisation):
//
//   npm run contract:core -- --base-url https://studio-staging.internal --token <staging token>
//
// (or STUDIO_CONTRACT_BASE_URL / STUDIO_CONTRACT_TOKEN in the environment, which keeps the token
// out of shell history). Exit 0 when every check passes, 1 otherwise. See integrations/core/README.md.

async function main(): Promise<void> {
  const args = parseContractArgs(process.argv.slice(2));
  const report = await runCoreContract(args);
  process.stdout.write(formatContractReport(report));
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((err: unknown) => {
  logger.error({ err }, 'contract suite could not run');
  process.exitCode = 1;
});
